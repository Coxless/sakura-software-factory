/**
 * 回帰評価の実行器（012 US2・US4・US5、data-model.md 2章、research R6・R7）。
 *
 *   for 回 = 1 .. repeat, for ケース:
 *     止まっていれば not_run。評価全体の残りと月の残りを確かめる（足りなければ止めて not_run）
 *     jobs に1行 → 用意（複製・作業場）→ 005 の runPipeline（判定まで）→ 隠しチェック → 比較用の検査役 → 片付け
 *     成功 = 工程が passed かつ隠しチェックが passed
 *
 * 出荷（commit・push・PR）・GitHub は呼ばない（FR-009）。例外は投げない。
 */
import { and, eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import { canAcceptNewJob } from "../llm/budget.ts";
import { apiKeyEnvOf, providerOf } from "../llm/provider.ts";
import type { GateDeps } from "../llm/stream.ts";
import { type PipelinePhase, type PipelineResult, runPipeline } from "../pipeline/run.ts";
import { judge } from "../pipeline/verify.ts";
import { countLlmCallsForJob } from "../queue/llm-calls.ts";
import { jobs, llmCalls } from "../queue/schema.ts";
import { maskDeep } from "../trace/writer.ts";
import type { EvalCase, EvalSet } from "./cases.ts";
import { type GraderRun, runGrader, withCheckCommands } from "./grade.ts";
import type { PrepareCase, PreparedCase } from "./prepare.ts";
import {
  type CaseResult,
  type EvalModels,
  type EvalRun,
  type Judgement,
  makeRunId,
  type StopReason,
  summarize,
} from "./result.ts";

export interface HarnessVersion {
  commit: string;
  dirty: boolean;
}

export interface EvalRunnerDeps {
  gate: GateDeps;
  prepare: PrepareCase;
  now?: () => number;
  /** ハーネスの版（既定の CLI では git rev-parse HEAD と git status） */
  harness: () => Promise<HarnessVersion>;
}

export type EvalProgress =
  | { type: "case_start"; caseId: string; attempt: number; index: number; total: number }
  | { type: "phase"; caseId: string; phase: PipelinePhase; round: number }
  | { type: "grading"; caseId: string }
  | { type: "judging_alt"; caseId: string }
  | { type: "case_end"; result: CaseResult }
  | { type: "stopped"; reason: StopReason };

export interface EvalRunInput {
  set: EvalSet;
  repeat: number;
  /** 評価全体のリクエスト上限 */
  maxRequests: number;
  /** 1ケースの期限（分） */
  timeoutMinutes: number;
  /** 結果に残す絞り込み（--cases） */
  cases: string[] | null;
  signal?: AbortSignal;
  onProgress?: (event: EvalProgress) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 既定の最大のリクエスト数（ケース数 × 回数 × 1ジョブの上限） */
export function defaultMaxRequests(
  caseCount: number,
  repeat: number,
  config: FactoryConfig,
): number {
  return caseCount * repeat * config.budget.per_job_requests;
}

export function modelsOf(config: FactoryConfig): EvalModels {
  return {
    planner: config.models.planner,
    implementer: config.models.implementer,
    verifier: config.models.verifier,
    ...(config.models.verifier_alt === undefined
      ? {}
      : { verifier_alt: config.models.verifier_alt }),
  };
}

/** ジョブのその工程の LLM 呼び出しの集計 */
function callStats(gate: GateDeps, jobId: number, phase: string) {
  const rows = gate.db
    .select({
      input: llmCalls.input_tokens,
      output: llmCalls.output_tokens,
      latency: llmCalls.latency_ms,
    })
    .from(llmCalls)
    .where(and(eq(llmCalls.job_id, jobId), eq(llmCalls.phase, phase)))
    .all();
  return {
    calls: rows.length,
    inputTokens: rows.reduce((sum, r) => sum + (r.input ?? 0), 0),
    outputTokens: rows.reduce((sum, r) => sum + (r.output ?? 0), 0),
    latencyMs: rows.reduce((sum, r) => sum + r.latency, 0),
  };
}

/** 失敗したコマンドの要約 */
function graderFailureText(grader: GraderRun): string {
  const failed = grader.results.find((r) => r.exitCode !== 0);
  if (!failed) return "隠しチェックが通りませんでした";
  return `隠しチェックが通りませんでした（${failed.command} → 終了コード ${failed.exitCode}${failed.timedOut ? "、時間切れ" : ""}）`;
}

/** 評価を実行する。例外は投げない */
export async function runEvals(deps: EvalRunnerDeps, input: EvalRunInput): Promise<EvalRun> {
  const { gate } = deps;
  const { config, db } = gate;
  const now = deps.now ?? gate.now ?? Date.now;
  const secrets = [gate.apiKey, process.env[apiKeyEnvOf(config)]].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  const mask = <T>(value: T): T => maskDeep(value, secrets) as T;
  const models = modelsOf(config);
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs);
  const runId = makeRunId(startedAt, input.set.name);
  const harness = await deps.harness().catch(() => ({ commit: "unknown", dirty: false }));
  const progress = (event: EvalProgress) => {
    try {
      input.onProgress?.(event);
    } catch (error) {
      gate.logger.warn({ err: error }, "onProgress が例外を投げました");
    }
  };

  const items: { evalCase: EvalCase; attempt: number }[] = [];
  for (let attempt = 1; attempt <= input.repeat; attempt++) {
    for (const evalCase of input.set.cases) items.push({ evalCase, attempt });
  }

  const results: CaseResult[] = [];
  const jobIds: number[] = [];
  const used = () => jobIds.reduce((sum, id) => sum + countLlmCallsForJob(db, id), 0);
  let stopped: StopReason | undefined;
  const stop = (reason: StopReason) => {
    if (stopped) return;
    stopped = reason;
    progress({ type: "stopped", reason });
  };

  for (const [index, { evalCase, attempt }] of items.entries()) {
    const base = {
      caseId: evalCase.id,
      caseHash: evalCase.hash,
      workType: evalCase.workType,
      attempt,
    };
    const notRun = (reason: string): CaseResult => ({
      ...base,
      status: "not_run",
      reason,
      requests: 0,
      durationMs: 0,
    });
    if (!stopped && input.signal?.aborted) stop("aborted");
    const remaining = input.maxRequests - used();
    if (!stopped && remaining <= 0) stop("max_requests");
    if (stopped) {
      results.push(notRun(`評価が止まったため実行していません（${stopped}）`));
      continue;
    }

    // ケースごとの設定: 1ジョブの上限を評価全体の残りまで下げ、工程内テストのコマンドをケースのものにする
    const perJob = Math.min(config.budget.per_job_requests, remaining);
    const caseConfig = withCheckCommands(
      { ...config, budget: { ...config.budget, per_job_requests: perJob } } as FactoryConfig,
      evalCase.checkCommands,
    );
    // 原則 V: 月の残りが1ジョブの上限を下回ったら始めない（評価は受付を通らないので、ここで確かめる）
    const acceptance = canAcceptNewJob(db, caseConfig, now());
    if (!acceptance.accept) {
      stop("budget_exceeded");
      results.push(
        notRun(
          `月の残り（${acceptance.remaining}）が1ジョブの上限（${perJob}）を下回るため実行していません`,
        ),
      );
      continue;
    }

    progress({
      type: "case_start",
      caseId: evalCase.id,
      attempt,
      index: index + 1,
      total: items.length,
    });
    const caseGate: GateDeps = { ...gate, config: caseConfig };
    let jobId: number | undefined;
    let prepared: PreparedCase | undefined;
    let result: CaseResult;
    try {
      const created = now();
      const [job] = db
        .insert(jobs)
        .values({
          repo: `eval:${input.set.name}/${evalCase.id}`,
          issue_number: 0,
          trigger_comment_id: startedAtMs + index,
          requested_by: "eval",
          instruction: evalCase.instruction ?? "eval",
          status: "planning",
          created_at: created,
          updated_at: created,
          started_at: created,
        })
        .returning()
        .all();
      jobId = job?.id as number;
      jobIds.push(jobId);
      const currentJobId = jobId;
      prepared = await deps.prepare(evalCase, caseConfig, jobId);
      const started = now();
      const pipeline: PipelineResult = await runPipeline(
        {
          gate: caseGate,
          now,
          ...(prepared.diff ? { diff: prepared.diff } : {}),
          ...(prepared.listFiles ? { listFiles: prepared.listFiles } : {}),
        },
        {
          jobId,
          workspace: prepared.workspace,
          workdir: prepared.workdir,
          issue: { title: evalCase.title, body: evalCase.body },
          ...(evalCase.instruction ? { instruction: evalCase.instruction } : {}),
          deadline: started + input.timeoutMinutes * 60_000,
          ...(input.signal ? { signal: input.signal } : {}),
          onPhase: (phase, round) =>
            progress({ type: "phase", caseId: evalCase.id, phase, round }),
        },
      );
      const aborted = pipeline.outcome === "aborted";

      // 隠しチェック（中断で止まったときは行わない）
      let grader: GraderRun | undefined;
      if (!aborted) {
        progress({ type: "grading", caseId: evalCase.id });
        grader = await runGrader(prepared, evalCase, caseConfig, {
          signal: input.signal ?? new AbortController().signal,
          now,
          secrets,
        });
      }
      const durationMs = Math.max(0, now() - started);

      // 主の検査役の最後の判定
      const comparable =
        pipeline.lastJudge !== undefined &&
        pipeline.lastJudge.diff === pipeline.diff &&
        (grader?.status === "passed" || grader?.status === "failed");
      const verifier: Judgement | undefined = pipeline.lastJudge
        ? {
            model: config.models.verifier,
            verdict: pipeline.verdict?.verdict ?? "none",
            ...(pipeline.verdict ? {} : { error: pipeline.reason }),
            comparable,
            ...callStats(gate, currentJobId, "judge"),
          }
        : undefined;

      // 比較用の検査役（同じ入力で1回。ケースの結果には使わない）
      let verifierAlt: Judgement | undefined;
      let altBudgetExceeded = false;
      const altModel = config.models.verifier_alt;
      if (altModel !== undefined && pipeline.lastJudge && !aborted && !input.signal?.aborted) {
        progress({ type: "judging_alt", caseId: evalCase.id });
        const alt = await judge(
          { gate: caseGate, now },
          {
            jobId,
            issue: { title: evalCase.title, body: evalCase.body },
            ...(evalCase.instruction ? { instruction: evalCase.instruction } : {}),
            planText: pipeline.planText,
            diff: pipeline.lastJudge.diff,
            checks: pipeline.lastJudge.checks,
            ...(input.signal ? { signal: input.signal } : {}),
          },
          { alt: true },
        );
        altBudgetExceeded = alt.kind === "budget_exceeded";
        verifierAlt = {
          model: altModel,
          verdict: alt.kind === "ok" ? alt.value.verdict : "none",
          ...(alt.kind === "ok"
            ? {}
            : {
                error:
                  alt.kind === "invalid"
                    ? `出力が2回とも決められた形に合いません: ${alt.errors.join(" / ")}`
                    : alt.error,
              }),
          comparable,
          ...callStats(gate, currentJobId, "judge_alt"),
        };
      }

      const requests = countLlmCallsForJob(db, jobId);
      const pipelineSummary = {
        outcome: pipeline.outcome,
        retries: pipeline.retries,
        rounds: pipeline.rounds.length,
        requests: pipeline.requests,
        diffStat: pipeline.diffStat,
        ...(pipeline.plan ? { planWorkType: pipeline.plan.work_type } : {}),
        tracePath: pipeline.tracePath,
      };
      const graderSummary = grader
        ? {
            status: grader.status,
            results: grader.results.map((r) => ({
              command: r.command,
              exitCode: r.exitCode,
              durationMs: r.durationMs,
              timedOut: r.timedOut,
              output: r.output,
            })),
            ...(grader.error ? { error: grader.error } : {}),
          }
        : undefined;
      const common = {
        ...base,
        jobId,
        pipeline: pipelineSummary,
        ...(graderSummary ? { grader: graderSummary } : {}),
        ...(verifier ? { verifier } : {}),
        ...(verifierAlt ? { verifierAlt } : {}),
        requests,
        durationMs,
      };
      if (pipeline.outcome !== "passed") {
        result = { ...common, status: "failed", failure: "pipeline", reason: pipeline.reason };
      } else if (!grader || grader.status === "unavailable") {
        result = {
          ...common,
          status: "error",
          reason: `隠しチェックを実行できません: ${grader?.error ?? ""}`,
        };
      } else if (grader.status === "failed") {
        result = { ...common, status: "failed", failure: "grader", reason: graderFailureText(grader) };
      } else {
        result = { ...common, status: "succeeded", reason: pipeline.reason };
      }

      // 止める判断（research R7）
      if (aborted) stop("aborted");
      else if (pipeline.outcome === "budget_exceeded" || altBudgetExceeded) {
        // 1ジョブの上限に届いていなければ月の予算切れ。届いていれば、評価全体の残りで次のケースの前に判断する
        if (requests < perJob) stop("budget_exceeded");
      }
    } catch (error) {
      result = {
        ...base,
        ...(jobId === undefined ? {} : { jobId }),
        status: "error",
        reason: `実行できません: ${errorText(error)}`,
        requests: jobId === undefined ? 0 : countLlmCallsForJob(db, jobId),
        durationMs: 0,
      };
      if (input.signal?.aborted) stop("aborted");
    } finally {
      if (prepared) {
        await prepared.close().catch((error: unknown) => {
          gate.logger.error({ err: error, caseId: evalCase.id }, "作業場を片付けられませんでした");
        });
      }
    }
    const masked = mask(result);
    results.push(masked);
    progress({ type: "case_end", result: masked });
  }

  return {
    version: 1,
    runId,
    setName: input.set.name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(now()).toISOString(),
    harness,
    provider: providerOf(config).id,
    models,
    options: { cases: input.cases, repeat: input.repeat, maxRequests: input.maxRequests },
    ...(stopped ? { stopped } : {}),
    cases: results,
    summary: summarize(results, models),
  };
}
