/**
 * 実装工程の組み立て（004）。Pi（pi-agent-core）の Agent に、002 の予算ゲート・003 の4ツールと検査・整形、
 * コンテキストの圧縮・停止条件・軌跡の記録をつなぐ。
 *
 * pi-agent-core を import するのはこのファイルだけ（research R9）。入口と結果の型は Pi の型を含まない。
 * 土台を切り替えるときに書き直すのは、このファイルの startImplementer の中身だけ。
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import Type from "typebox";
import Value from "typebox/value";
import type { ToolDetails, ToolResult } from "../harness/compose.ts";
import {
  buildInitialContext,
  compactContext,
  type Feedback,
  steeringMessage,
} from "../harness/context.ts";
import { StopTracker } from "../harness/stop.ts";
import type { Workspace } from "../harness/workspace.ts";
import { apiKeyEnvOf, modelForRole } from "../llm/provider.ts";
import {
  createGatedStreamFn,
  type GateDeps,
  getBudgetExceeded,
  type Model,
} from "../llm/stream.ts";
import { countLlmCallsForJob } from "../queue/llm-calls.ts";
import type { AgentRunOutcome } from "../queue/schema.ts";
import { finishAgentRun, startAgentRun } from "../trace/runs.ts";
import {
  maskDeep,
  openTraceWriter,
  type TraceRecordBody,
  type TraceWriter,
  traceFileName,
} from "../trace/writer.ts";

export type { Feedback } from "../harness/context.ts";

export type ImplementerOutcome = AgentRunOutcome;

export const IMPLEMENT_PHASE = "implement";

/** 作業を止めて人に返すツール（作業場では動かさず、ホストで理由を受け取るだけ） */
export const HAND_BACK_TOOL = "hand_back";
const HAND_BACK_MAX_CHARS = 2000;
const HandBackParams = Type.Object({
  reason: Type.String({ minLength: 1, description: "止めた理由。Issue にそのまま投稿される" }),
});

/** hand_back の理由を取り出す。形が合わなければ undefined */
function handBackReasonOf(params: unknown): string | undefined {
  if (!Value.Check(HandBackParams, params)) return undefined;
  const reason = params.reason.trim();
  if (reason === "") return undefined;
  return reason.length > HAND_BACK_MAX_CHARS ? `${reason.slice(0, HAND_BACK_MAX_CHARS)}…` : reason;
}

export interface ImplementerInput {
  jobId: number;
  workspace: Workspace;
  /** Issue のタイトルと本文 */
  issue: string;
  /** 計画役の出力（005）。テストと pipeline:dev の --plan では手書き */
  plan: string;
  /** やり直しのとき（005・009）。毎回新しい会話で始める */
  feedback?: Feedback[];
  /** UTC の Unix ミリ秒。ジョブ全体の期限から呼び出し側が決める */
  deadline: number;
  /** 既定は [limits].max_turns_per_phase */
  maxTurns?: number;
  /** 呼び出し側の中断 */
  signal?: AbortSignal;
  /**
   * 実装役が完了を告げた（ツールを呼ばず、差し込みもない）ときに呼ぶ（005 の工程内テスト）。
   * 文字列を返すと差し込んで続ける（ターン数の上限は数え続ける）。undefined なら完了で終わる。
   * 例外を投げると終わり方は failed（error に原因）
   */
  onComplete?: (signal: AbortSignal) => Promise<string | undefined>;
}

export interface ImplementerDeps {
  gate: GateDeps;
  /** 既定は gate.now ?? Date.now */
  now?: () => number;
  /** テスト専用: 実装役のモデルを差し替える（contextWindow を小さくするなど） */
  model?: Model<"openai-completions">;
}

export interface ImplementerResult {
  outcome: ImplementerOutcome;
  /** 最後の assistant メッセージの本文（なければ空） */
  lastMessage: string;
  /** 最後の応答が出力の上限で切れた */
  truncatedOutput: boolean;
  turns: number;
  /** llm_calls の増分（リトライを含む） */
  requests: number;
  toolCalls: number;
  blockedCalls: number;
  /** failed・budget_exceeded のとき（マスク済み） */
  error?: string;
  /** handed_back のとき: 実装役が書いた止めた理由（マスク済み） */
  handBackReason?: string;
  /** agent_runs.id（行を作れなかったら 0） */
  runId: number;
  attempt: number;
  /** 軌跡のファイルの絶対パス */
  tracePath: string;
  /** onComplete を呼んだ回数（005） */
  completionChecks: number;
}

export interface ImplementerRun {
  /** 実行中ならメッセージを差し込んで true。終わったあとは false */
  steer(text: string): boolean;
  /** 中断する（signal を渡すのと同じ） */
  abort(): void;
  /** 例外で reject しない */
  result: Promise<ImplementerResult>;
}

function textOf(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolResultChars(result: { content: readonly unknown[] }): number {
  let chars = 0;
  for (const part of result.content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      chars += (part as { text: string }).text.length;
    }
  }
  return chars;
}

/** 実装工程を1回実行する。例外は投げず、終わり方として返す */
export function runImplementer(
  deps: ImplementerDeps,
  input: ImplementerInput,
): Promise<ImplementerResult> {
  return startImplementer(deps, input).result;
}

/** 実装工程を始め、差し込みと中断のための取っ手を返す */
export function startImplementer(deps: ImplementerDeps, input: ImplementerInput): ImplementerRun {
  const { gate } = deps;
  const { config, db } = gate;
  const now = deps.now ?? gate.now ?? Date.now;
  const secrets = [gate.apiKey, process.env[apiKeyEnvOf(config)]].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  const mask = (text: string) => maskDeep(text, secrets) as string;

  let agent: Agent | undefined;
  let running = true;
  let userAborted = false;
  let traceError: unknown;
  let writer: TraceWriter | undefined;
  let steers = 0;
  let completionChecks = 0;
  let completionError: unknown;
  let handBackReason: string | undefined;
  const pendingSteers: string[] = [];

  const write = (record: TraceRecordBody) => {
    if (!writer || traceError !== undefined) return;
    try {
      writer.write(record);
    } catch (error) {
      traceError = error;
      agent?.abort();
    }
  };

  const abort = () => {
    if (!running) return;
    userAborted = true;
    agent?.abort();
  };
  if (input.signal?.aborted) userAborted = true;
  input.signal?.addEventListener("abort", abort, { once: true });

  const steer = (text: string): boolean => {
    if (!running) {
      write({ type: "steer", text, accepted: false });
      return false;
    }
    steers += 1;
    write({ type: "steer", text, accepted: true });
    const content = steeringMessage(text);
    if (agent) agent.steer({ role: "user", content, timestamp: now() });
    else pendingSteers.push(content);
    return true;
  };

  const result = (async (): Promise<ImplementerResult> => {
    const startedAt = now();
    const requestsBefore = countLlmCallsForJob(db, input.jobId);
    let model: Model<"openai-completions">;
    let runId = 0;
    let attempt = 0;
    let tracePath = "";
    const counters = { toolCalls: 0, blockedCalls: 0, compactions: 0, requests: 0 };
    let stop: StopTracker | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let outcome: ImplementerOutcome = "failed";
    let error: string | undefined;
    let lastAssistant: AssistantMessage | undefined;

    try {
      model = deps.model ?? modelForRole(gate.models, config, "implementer");
      const run = startAgentRun(db, {
        jobId: input.jobId,
        phase: IMPLEMENT_PHASE,
        model: model.id,
        tracePath: traceFileName(input.jobId),
        startedAt,
      });
      runId = run.id;
      attempt = run.attempt;
      writer = openTraceWriter({
        traceDir: config.storage.trace_dir,
        jobId: input.jobId,
        runId,
        phase: IMPLEMENT_PHASE,
        attempt,
        secrets,
        now,
      });
      tracePath = writer.path;

      const limits = config.implementer;
      const maxTurns = input.maxTurns ?? config.limits.max_turns_per_phase;
      stop = new StopTracker(
        { maxTurns, deadline: input.deadline, maxConsecutiveBlocks: limits.max_consecutive_blocks },
        now,
      );
      const tracker = stop;

      const agentsMd = await input.workspace.readAgentsMd();
      const initial = buildInitialContext(
        { agentsMd, issue: input.issue, plan: input.plan, feedback: input.feedback ?? [] },
        limits,
      );
      write({
        type: "run_start",
        model: model.id,
        systemPrompt: initial.systemPrompt,
        initialMessage: initial.initialMessage,
        limits: {
          maxTurns,
          deadline: input.deadline,
          maxConsecutiveBlocks: limits.max_consecutive_blocks,
          compactionRatio: limits.compaction_ratio,
          keepRecentTurns: limits.keep_recent_turns,
          contextWindow: model.contextWindow,
        },
        truncated: initial.truncated,
      });
      if (traceError !== undefined) throw traceError;

      const handBack: AgentTool = {
        name: HAND_BACK_TOOL,
        label: "作業を止めて人に返す",
        description:
          "作業を止めて、判断を人に返す。Issue の指示どおりに止めるとき（「〜なら報告して止めて」）や、この作業場では依頼を満たせないと分かったとき（必要な情報・履歴・ネットワークがない）だけに使う。reason は Issue にそのまま投稿される。呼ぶとそこで作業が終わり、変更は push されない",
        parameters: HandBackParams,
        executionMode: "sequential",
        execute: async (_id: string, params: unknown) => {
          const reason = handBackReasonOf(params);
          if (reason === undefined) {
            return {
              content: [{ type: "text", text: "reason に止めた理由を書いてください" }],
              details: { tool: HAND_BACK_TOOL, error: "invalid_args" },
              isError: true,
            };
          }
          handBackReason = reason;
          return {
            content: [{ type: "text", text: "作業を止めました。これ以上の操作は要りません" }],
            details: { tool: HAND_BACK_TOOL },
          };
        },
      } as unknown as AgentTool;

      const created = new Agent({
        initialState: {
          systemPrompt: initial.systemPrompt,
          model,
          thinkingLevel: "off",
          tools: [...(input.workspace.tools as unknown as AgentTool[]), handBack],
        },
        streamFn: createGatedStreamFn(gate, {
          jobId: input.jobId,
          phase: IMPLEMENT_PHASE,
          role: "implementer",
        }),
        toolExecution: "sequential",
        steeringMode: "all",
        transformContext: async (messages) => {
          counters.requests += 1;
          try {
            const compacted = compactContext(messages, {
              contextWindow: model.contextWindow,
              compactionRatio: limits.compaction_ratio,
              keepRecentTurns: limits.keep_recent_turns,
            });
            if (compacted.compactedToolCallIds.length > 0) counters.compactions += 1;
            write({
              type: "request",
              turn: counters.requests,
              estimatedTokens: compacted.estimatedTokens,
              compactedToolCallIds: compacted.compactedToolCallIds,
              estimatedTokensAfter: compacted.estimatedTokensAfter,
            });
            return compacted.messages as AgentMessage[];
          } catch (failure) {
            write({ type: "note", message: `圧縮に失敗しました: ${errorText(failure)}` });
            return messages;
          }
        },
        beforeToolCall: async ({ toolCall, args }, signal) => {
          // hand_back は作業場に触れないので検査しない。止めたあとのツールは実行しない
          if (handBackReason !== undefined) {
            return { block: true, reason: "作業は止めました。これ以上の操作は要りません" };
          }
          if (toolCall.name === HAND_BACK_TOOL) return undefined;
          const decision = await input.workspace.guard({ toolName: toolCall.name, args }, signal);
          if (!decision) return undefined;
          counters.blockedCalls += 1;
          tracker.onBlocked();
          write({
            type: "tool_blocked",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            guard: decision.guard,
            reason: decision.reason,
          });
          return { block: true, reason: decision.reason };
        },
        afterToolCall: async ({ toolCall, args, result: executed, isError }) => {
          counters.toolCalls += 1;
          const details = (executed.details ?? { tool: toolCall.name }) as ToolDetails;
          if (toolCall.name === HAND_BACK_TOOL) {
            tracker.onToolResult(details);
            write({
              type: "tool_result_meta",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              originalChars: toolResultChars(executed),
              details:
                handBackReason === undefined ? details : { ...details, reason: handBackReason },
            });
            return undefined;
          }
          const original: ToolResult = {
            content: executed.content.filter(
              (part): part is { type: "text"; text: string } => part.type === "text",
            ),
            details,
            isError,
          };
          const shaped = await input.workspace.transform(
            { toolName: toolCall.name, args },
            original,
          );
          tracker.onToolResult(shaped.details);
          write({
            type: "tool_result_meta",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            originalChars: toolResultChars(executed),
            details: shaped.details,
          });
          return {
            content: shaped.content,
            details: { ...shaped.details, originalChars: toolResultChars(executed) },
            isError: shaped.isError,
          };
        },
        finishTurn: async ({ message, toolResults }, signal) => {
          if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
          tracker.onTurnEnd();
          // 人に返したら、工程内テストも上限の判定もせずに終わる
          if (handBackReason !== undefined) return { action: "end" };
          let continues = toolResults.length > 0 || created.hasQueuedMessages();
          let injected = false;
          // 完了を告げたとき: 005 の工程内テスト。失敗なら同じ会話に差し込んで続ける（research R4）
          if (!continues && input.onComplete) {
            completionChecks += 1;
            try {
              const text = await input.onComplete(
                signal ?? created.signal ?? new AbortController().signal,
              );
              if (text !== undefined && steer(text)) {
                continues = true;
                injected = true;
              }
            } catch (failure) {
              completionError = failure;
              return { action: "end" };
            }
          }
          // ツールを呼ばず、差し込みもなければ自然に終わる（完了）。上限の判定はしない
          if (!continues) return undefined;
          if (tracker.check()) return { action: "end" };
          return injected ? { action: "continue" } : undefined;
        },
      });
      agent = created;

      let firstUser = true;
      created.subscribe((event: AgentEvent) => {
        if (event.type !== "message_end") return;
        const message = event.message;
        if (message.role === "user" && firstUser) {
          firstUser = false;
          return;
        }
        if (message.role === "assistant") lastAssistant = message as AssistantMessage;
        write({ type: "message", message });
      });

      for (const content of pendingSteers.splice(0)) {
        created.steer({ role: "user", content, timestamp: now() });
      }

      const remaining = input.deadline - now();
      if (remaining <= 0) {
        tracker.onDeadlineAbort();
      } else {
        deadlineTimer = setTimeout(() => {
          tracker.onDeadlineAbort();
          created.abort();
        }, remaining);
        deadlineTimer.unref?.();
      }

      if (!userAborted && tracker.reason === undefined) {
        await created.prompt({ role: "user", content: initial.initialMessage, timestamp: now() });
      }

      // 終わり方を決める（research R12）
      const budget = lastAssistant ? getBudgetExceeded(lastAssistant) : undefined;
      if (traceError !== undefined) {
        outcome = "failed";
        error = `軌跡に書けませんでした: ${errorText(traceError)}`;
      } else if (handBackReason !== undefined && !userAborted && tracker.reason !== "timeout") {
        outcome = "handed_back";
      } else if (completionError !== undefined) {
        outcome = "failed";
        error = errorText(completionError);
      } else if (tracker.reason === "sandbox_unavailable") {
        outcome = "failed";
        error = "作業場が使えないエラーが続きました";
      } else if (budget) {
        outcome = "budget_exceeded";
        error = lastAssistant?.errorMessage;
      } else if (tracker.reason === "timeout") {
        outcome = "timeout";
      } else if (userAborted) {
        outcome = "aborted";
      } else if (tracker.reason === "max_turns") {
        outcome = "max_turns";
      } else if (tracker.reason === "blocked_repeatedly") {
        outcome = "blocked_repeatedly";
      } else if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
        outcome = "failed";
        error = lastAssistant.errorMessage ?? "LLM の呼び出しに失敗しました";
      } else if (lastAssistant === undefined) {
        outcome = "failed";
        error = created.state.errorMessage ?? "LLM の応答がありません";
      } else {
        outcome = "completed";
      }
    } catch (failure) {
      outcome = "failed";
      error =
        traceError !== undefined
          ? `軌跡に書けませんでした: ${errorText(traceError)}`
          : errorText(failure);
    } finally {
      running = false;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      input.signal?.removeEventListener("abort", abort);
    }

    const maskedError = error === undefined ? undefined : mask(error);
    const maskedHandBack =
      outcome === "handed_back" && handBackReason !== undefined ? mask(handBackReason) : undefined;
    const summary = {
      outcome,
      turns: stop?.turns ?? 0,
      requests: countLlmCallsForJob(db, input.jobId) - requestsBefore,
      toolCalls: counters.toolCalls,
      blockedCalls: counters.blockedCalls,
      compactions: counters.compactions,
      steers,
    };
    const lastMessage = textOf(lastAssistant);
    const truncatedOutput = lastAssistant?.stopReason === "length";
    write({
      type: "run_end",
      ...summary,
      lastMessage,
      truncatedOutput,
      ...(maskedError === undefined ? {} : { error: maskedError }),
      ...(maskedHandBack === undefined ? {} : { handBackReason: maskedHandBack }),
    });
    if (runId !== 0) {
      try {
        finishAgentRun(db, runId, {
          ...summary,
          ...(maskedError === undefined ? {} : { error: maskedError }),
          finishedAt: now(),
        });
      } catch (failure) {
        gate.logger.error({ err: failure, runId }, "agent_runs を更新できませんでした");
      }
    }
    return {
      ...summary,
      lastMessage,
      truncatedOutput,
      ...(maskedError === undefined ? {} : { error: maskedError }),
      ...(maskedHandBack === undefined ? {} : { handBackReason: maskedHandBack }),
      runId,
      attempt,
      tracePath,
      completionChecks,
    };
  })();

  return { steer, abort, result };
}
