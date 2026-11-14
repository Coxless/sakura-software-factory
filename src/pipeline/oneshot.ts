/**
 * 計画役・検査役で共通の「ツールなしの1回呼び出し → JSON の取り出し → 検証 → 合わなければ再要求1回 → 記録」
 * （005 research R1・R2・R9、原則 III・V）。Pi に依存しない。例外を投げない。
 */
import type { Static, TSchema } from "typebox";
import { extractJsonObject, repairMessage, validate } from "../harness/structured.ts";
import { type CompletionMessage, completeOnce } from "../llm/complete.ts";
import { apiKeyEnvOf, type ModelRole } from "../llm/provider.ts";
import type { GateDeps } from "../llm/stream.ts";
import { countLlmCallsForJob } from "../queue/llm-calls.ts";
import type { AgentRunOutcome, LlmRole, VerdictValue } from "../queue/schema.ts";
import { finishAgentRun, startAgentRun } from "../trace/runs.ts";
import {
  maskDeep,
  openTraceWriter,
  type TraceRecordBody,
  type TraceWriter,
  traceFileName,
} from "../trace/writer.ts";

export type OneShotFailureKind = "failed" | "budget_exceeded" | "timeout" | "aborted";

export type OneShotOutcome<T> =
  | { kind: "ok"; value: T; text: string; requests: number; runId: number }
  /** 2回とも形が合わない */
  | { kind: "invalid"; errors: string[]; requests: number; runId: number }
  | { kind: OneShotFailureKind; error: string; requests: number; runId: number };

export interface OneShotDeps {
  gate: GateDeps;
  now?: () => number;
}

export interface OneShotRequest<S extends TSchema> {
  jobId: number;
  /** judge_alt は 012 の回帰評価での比較用の検査役 */
  phase: "plan" | "judge" | "judge_alt";
  /** llm_calls.role に書く役割 */
  role: Extract<LlmRole, "planner" | "verifier">;
  /** モデルを引く役割（既定は role）。比較用の検査役は "verifier_alt"（012） */
  modelRole?: Extract<ModelRole, "planner" | "verifier" | "verifier_alt">;
  schema: S;
  systemPrompt: string;
  userMessage: string;
  /** 入力で切り詰めた部分の名前（軌跡に残す） */
  truncated: readonly string[];
  signal?: AbortSignal;
  /** signal が中止されたとき、期限か呼び出し側の中断かを答える（既定は aborted） */
  abortReason?: () => "timeout" | "aborted";
  /** 検証に通った値から、agent_runs.verdict に書く値を決める（判定のとき） */
  verdictOf?: (value: Static<S>) => VerdictValue | undefined;
}

/** 再要求は1回まで（原則 III） */
export const MAX_ONE_SHOT_CALLS = 2;

class TraceWriteError extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OUTCOME_OF: Record<OneShotOutcome<unknown>["kind"], AgentRunOutcome> = {
  ok: "completed",
  invalid: "failed",
  failed: "failed",
  budget_exceeded: "budget_exceeded",
  timeout: "timeout",
  aborted: "aborted",
};

/** 1回呼び出し（再要求1回まで）を実行して記録する。例外は投げない */
export async function runOneShot<S extends TSchema>(
  deps: OneShotDeps,
  req: OneShotRequest<S>,
): Promise<OneShotOutcome<Static<S>>> {
  const { gate } = deps;
  const { db, config } = gate;
  const now = deps.now ?? gate.now ?? Date.now;
  const secrets = [gate.apiKey, process.env[apiKeyEnvOf(config)]].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  const mask = (text: string) => maskDeep(text, secrets) as string;
  const before = countLlmCallsForJob(db, req.jobId);
  const requests = () => countLlmCallsForJob(db, req.jobId) - before;
  const modelRole = req.modelRole ?? req.role;
  const model = config.models[modelRole] ?? "";

  let runId = 0;
  let writer: TraceWriter | undefined;
  let calls = 0;
  let outcome: OneShotOutcome<Static<S>> | undefined;
  let verdict: VerdictValue | undefined;

  const write = (record: TraceRecordBody) => {
    if (!writer) return;
    try {
      writer.write(record);
    } catch (error) {
      throw new TraceWriteError(`軌跡に書けませんでした: ${errorText(error)}`);
    }
  };

  try {
    const run = startAgentRun(db, {
      jobId: req.jobId,
      phase: req.phase,
      model,
      tracePath: traceFileName(req.jobId),
      startedAt: now(),
    });
    runId = run.id;
    try {
      writer = openTraceWriter({
        traceDir: config.storage.trace_dir,
        jobId: req.jobId,
        runId,
        phase: req.phase,
        attempt: run.attempt,
        secrets,
        now,
      });
    } catch (error) {
      throw new TraceWriteError(`軌跡に書けませんでした: ${errorText(error)}`);
    }

    const history: CompletionMessage[] = [{ role: "user", text: req.userMessage }];
    let added: CompletionMessage[] = [...history];
    for (let call = 1; call <= MAX_ONE_SHOT_CALLS && outcome === undefined; call++) {
      write({
        type: "llm_request",
        model,
        systemPrompt: req.systemPrompt,
        messages: added,
        truncated: call === 1 ? [...req.truncated] : [],
      });
      calls = call;
      const result = await completeOnce(
        gate,
        { jobId: req.jobId, phase: req.phase, role: req.role },
        {
          role: modelRole,
          systemPrompt: req.systemPrompt,
          messages: history,
          ...(req.signal ? { signal: req.signal } : {}),
        },
      );
      if (!result.ok) {
        const kind: OneShotFailureKind = result.budgetExceeded
          ? "budget_exceeded"
          : result.aborted || req.signal?.aborted
            ? (req.abortReason?.() ?? "aborted")
            : "failed";
        const error = mask(result.error ?? "LLM の呼び出しに失敗しました");
        write({ type: "note", message: `LLM の呼び出しが終わりませんでした（${kind}）: ${error}` });
        outcome = { kind, error, requests: 0, runId };
        break;
      }
      write({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: result.text }],
          model: result.model,
          stopReason: result.truncated ? "length" : "stop",
          ...(result.usage ? { usage: result.usage } : {}),
        },
      });
      const extracted = extractJsonObject(result.text);
      const checked =
        extracted === undefined
          ? ({ ok: false, errors: [] } as const)
          : validate(req.schema, extracted);
      write({
        type: "validation",
        ok: checked.ok,
        extracted: extracted !== undefined,
        errors: checked.ok ? [] : [...checked.errors],
      });
      if (checked.ok) {
        verdict = req.verdictOf?.(checked.value);
        outcome = { kind: "ok", value: checked.value, text: result.text, requests: 0, runId };
        break;
      }
      if (call === MAX_ONE_SHOT_CALLS) {
        outcome = {
          kind: "invalid",
          errors:
            checked.errors.length > 0
              ? [...checked.errors]
              : ["出力から JSON オブジェクトを見つけられませんでした"],
          requests: 0,
          runId,
        };
        break;
      }
      added = [
        { role: "assistant", text: result.text },
        { role: "user", text: repairMessage(checked.errors) },
      ];
      history.push(...added);
    }
  } catch (error) {
    outcome = {
      kind: "failed",
      error: mask(
        error instanceof TraceWriteError
          ? error.message
          : `1回呼び出しに失敗しました: ${errorText(error)}`,
      ),
      requests: 0,
      runId,
    };
  }

  const final = outcome ?? {
    kind: "failed" as const,
    error: "1回呼び出しの結果がありません",
    requests: 0,
    runId,
  };
  final.requests = requests();
  const error =
    final.kind === "ok"
      ? undefined
      : final.kind === "invalid"
        ? mask(`出力が決められた形に合いません: ${final.errors.join(" / ")}`)
        : final.error;
  if (writer) {
    try {
      writer.write({
        type: "run_end",
        outcome: OUTCOME_OF[final.kind],
        turns: calls,
        requests: final.requests,
        toolCalls: 0,
        blockedCalls: 0,
        compactions: 0,
        steers: 0,
        lastMessage: final.kind === "ok" ? final.text : "",
        truncatedOutput: false,
        ...(error === undefined ? {} : { error }),
        ...(verdict === undefined ? {} : { verdict }),
      });
    } catch {
      // 書けなかったことは、上の write で既に failed として扱っている（run_end だけ書けないこともある）
    }
  }
  if (runId !== 0) {
    try {
      finishAgentRun(db, runId, {
        outcome: OUTCOME_OF[final.kind],
        turns: calls,
        requests: final.requests,
        toolCalls: 0,
        blockedCalls: 0,
        compactions: 0,
        steers: 0,
        ...(error === undefined ? {} : { error }),
        ...(verdict === undefined ? {} : { verdict }),
        finishedAt: now(),
      });
    } catch (failure) {
      gate.logger.error({ err: failure, runId }, "agent_runs を更新できませんでした");
    }
  }
  return final;
}
