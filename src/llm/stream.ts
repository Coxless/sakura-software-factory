/**
 * 予算ゲート（constitution 原則 V）。すべての LLM 呼び出しはここを通る。
 * 試行ごとに「予算の確認 → 1回送る → llm_calls に1件」を行い、一時的な失敗だけを再試行する。
 */
import { type StreamFn, setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import type { FactoryConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../queue/db.ts";
import { type LlmErrorKind, type LlmRole, llmCalls } from "../queue/schema.ts";
import { maskSecrets, REDACTED } from "../trace/mask.ts";
import {
  type BudgetExceededError,
  checkBudget,
  ensureBudgetMonth,
  parseBudgetExceeded,
} from "./budget.ts";
import { apiKeyEnvOf } from "./provider.ts";

/** 呼び出しの文脈。記録と予算の判断に使う */
export interface CallContext {
  /** ジョブ。null ならジョブの上限を見ない（スモークテスト・回帰評価） */
  jobId: number | null;
  /** 工程（plan / implement / judge / smoke など） */
  phase: string;
  role: LlmRole;
}

export interface GateDeps {
  db: Db;
  config: FactoryConfig;
  /** createLlmModels の結果（テストでも本物を使う） */
  models: Models;
  logger: Logger;
  /** APIキー。省くと提供元の認証（環境変数 SAKURA_AI_API_KEY）に任せる。マスクにも使う */
  apiKey?: string;
  /** ネットワークの手前。既定は globalThis.fetch、テストでは偽の fetch */
  fetch?: typeof fetch;
  /** 既定は Date.now */
  now?: () => number;
  /** 再試行の待ち。既定は setTimeout。テストでは待たずに進める */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 試行ごとの時間の上限。既定は AbortSignal.timeout。テストでは手動で中止できる signal */
  timeoutSignal?: (ms: number) => AbortSignal;
}

export interface TokenUsage {
  input: number;
  output: number;
}

/** 試行関数が返す、1回の試行の結果 */
export interface AttemptOutcome<T = unknown> {
  ok: boolean;
  /** 試行関数が種類を決められるときだけ指定する。省くとゲートが判定する */
  kind?: LlmErrorKind;
  /** 捕まえた HTTP の状態コード。省くとゲートの fetch が捕まえた値を使う */
  httpStatus?: number;
  usage?: TokenUsage;
  /** マスク前のエラー文（記録・返却の前にマスクする） */
  message?: string;
  value?: T;
}

/** 1回の試行。ゲートが渡す signal と fetch を使って送る */
export type AttemptFn<T> = (
  signal: AbortSignal,
  fetchFn: typeof globalThis.fetch,
) => Promise<AttemptOutcome<T>>;

/** 再試行しても成功しなかった、または再試行しない失敗 */
export class LlmCallError extends Error {
  readonly kind: LlmErrorKind;
  readonly attempts: number;
  readonly httpStatus: number | undefined;

  constructor(kind: LlmErrorKind, attempts: number, message: string, httpStatus?: number) {
    super(message);
    this.name = "LlmCallError";
    this.kind = kind;
    this.attempts = attempts;
    this.httpStatus = httpStatus;
  }
}

export const GUARD_MESSAGE = "LLM 呼び出しは予算ゲート（createGatedStreamFn）を通すこと";

/** ゲートの fetch が試行ごとに捕まえた HTTP の様子 */
interface Observed {
  called: boolean;
  status?: number;
  headers?: Headers;
  fetchError?: string;
}

function observingFetch(inner: typeof fetch, observed: Observed): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    observed.called = true;
    try {
      const response = await inner(input, init);
      observed.status = response.status;
      observed.headers = response.headers;
      return response;
    } catch (error) {
      observed.fetchError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }) as typeof fetch;
}

/** 応答の待ち時間の指示（retry-after-ms → retry-after〔秒または日付〕） */
export function retryAfterMs(headers: Headers | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms !== null && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.max(0, Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** 指数バックオフ: 0.5s × 2^(n-1)、上限 8s、0〜25% 短くするジッター */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return Math.round(base * (1 - random() * 0.25));
}

const TRANSIENT_MESSAGE = /terminated|ECONNRESET|socket|network|timeout|timed out/i;

export interface Classification {
  kind?: LlmErrorKind;
  retry: boolean;
  /** 再試行の前の待ち時間（retry のときだけ） */
  delayMs?: number;
}

/** 1回の試行の結果を、失敗の種類と再試行の可否に分ける（research R6） */
export function classifyAttempt(input: {
  ok: boolean;
  kind?: LlmErrorKind;
  message?: string;
  observed: Observed;
  callerAborted: boolean;
  timedOut: boolean;
  attempt: number;
  maxRetryDelayMs: number;
  now: number;
}): Classification {
  const { observed, attempt } = input;
  if (input.callerAborted) return { kind: "aborted", retry: false };
  if (input.timedOut) return { kind: "timeout", retry: true, delayMs: backoffMs(attempt) };
  if (input.ok) return { retry: false };
  if (input.kind !== undefined) {
    const retry = input.kind === "transient" || input.kind === "timeout";
    return retry
      ? { kind: input.kind, retry, delayMs: backoffMs(attempt) }
      : { kind: input.kind, retry };
  }

  const status = observed.status;
  const shouldRetry = observed.headers?.get("x-should-retry");
  if (status !== undefined && status >= 400) {
    if (shouldRetry === "false") return { kind: "permanent", retry: false };
    const retryable =
      shouldRetry === "true" || status === 408 || status === 409 || status === 429 || status >= 500;
    if (!retryable) return { kind: "permanent", retry: false };
    const instructed = retryAfterMs(observed.headers, input.now);
    if (instructed !== undefined && instructed > input.maxRetryDelayMs) {
      // このゲートの中ではもう再試行しない（research R6）。状態コードは error 列に残る
      return { kind: "permanent", retry: false };
    }
    return { kind: "transient", retry: true, delayMs: instructed ?? backoffMs(attempt) };
  }
  if (!observed.called) {
    // 送る前に失敗した（認証の設定がないなど）。再試行しても変わらない
    return { kind: "permanent", retry: false };
  }
  if (status === undefined) {
    // HTTP の応答がない（接続失敗・DNS・SDK の時間切れ）
    const kind = /timed? ?out/i.test(input.message ?? "") ? "timeout" : "transient";
    return { kind, retry: true, delayMs: backoffMs(attempt) };
  }
  // 200 のあと、応答の途中でエラー
  if (TRANSIENT_MESSAGE.test(`${input.message ?? ""} ${observed.fetchError ?? ""}`)) {
    return { kind: "transient", retry: true, delayMs: backoffMs(attempt) };
  }
  return { kind: "permanent", retry: false };
}

/** エラー文から秘密情報を伏せる。形のパターン（maskSecrets）に加え、使っている APIキーの値そのものを伏せる */
export function maskError(text: string, apiKey: string | undefined): string {
  let masked = maskSecrets(text);
  if (apiKey && apiKey.length >= 4) masked = masked.split(apiKey).join(REDACTED);
  return masked;
}

function composeError(message: string | undefined, observed: Observed, status?: number): string {
  let text = message?.trim() || "unknown error";
  if (observed.fetchError && !text.includes(observed.fetchError)) {
    text = `${text} (cause: ${observed.fetchError})`;
  }
  if (status !== undefined && !text.startsWith(String(status))) text = `${status} ${text}`;
  return text;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * ゲートの中核。StreamFn と素の HTTP（スモークテスト）の両方が使う。
 * 試行の前に毎回予算を確かめ、試行1回につき llm_calls に1件を書く。一時的な失敗だけを max_attempts 回まで再試行する。
 * 失敗時は BudgetExceededError か LlmCallError を投げる。
 */
export async function runGated<T>(
  deps: GateDeps,
  ctx: CallContext,
  model: string,
  attempt: AttemptFn<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const innerFetch = deps.fetch ?? globalThis.fetch;
  const apiKey = deps.apiKey ?? process.env[apiKeyEnvOf(deps.config)];
  const { max_attempts, max_retry_delay_seconds, request_timeout_seconds } = deps.config.llm;
  const callerSignal = options.signal;

  for (let attemptNo = 1; ; attemptNo++) {
    if (callerSignal?.aborted) {
      throw new LlmCallError("aborted", attemptNo - 1, "呼び出し元が取り消しました");
    }
    const startedAt = now();
    const exceeded = checkBudget(deps.db, deps.config, ctx.jobId, startedAt);
    if (exceeded) throw exceeded;
    ensureBudgetMonth(deps.db, deps.config, startedAt);

    const timeout = timeoutSignal(request_timeout_seconds * 1000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const observed: Observed = { called: false };
    const t0 = performance.now();
    let outcome: AttemptOutcome<T>;
    try {
      outcome = await attempt(signal, observingFetch(innerFetch, observed));
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - t0));

    const httpStatus = outcome.httpStatus ?? observed.status;
    const classified = classifyAttempt({
      ok: outcome.ok,
      ...(outcome.kind === undefined ? {} : { kind: outcome.kind }),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
      observed: { ...observed, ...(httpStatus === undefined ? {} : { status: httpStatus }) },
      callerAborted: callerSignal?.aborted === true,
      timedOut: timeout.aborted && callerSignal?.aborted !== true,
      attempt: attemptNo,
      maxRetryDelayMs: max_retry_delay_seconds * 1000,
      now: now(),
    });
    const succeeded = outcome.ok && classified.kind === undefined;
    const errorText = succeeded
      ? null
      : maskError(
          composeError(
            classified.kind === "timeout" && !outcome.message
              ? `request timed out after ${request_timeout_seconds}s`
              : outcome.message,
            observed,
            httpStatus,
          ),
          apiKey,
        );
    const usage = outcome.usage;

    try {
      deps.db
        .insert(llmCalls)
        .values({
          job_id: ctx.jobId,
          phase: ctx.phase,
          role: ctx.role,
          model,
          attempt: attemptNo,
          input_tokens: usage?.input ?? null,
          output_tokens: usage?.output ?? null,
          latency_ms: latencyMs,
          status: succeeded ? "ok" : "error",
          error_kind: succeeded ? null : (classified.kind ?? "permanent"),
          error: errorText,
          created_at: startedAt,
        })
        .run();
    } catch (error) {
      const reason = maskError(error instanceof Error ? error.message : String(error), apiKey);
      deps.logger.error(
        { err: error, model, attempt: attemptNo },
        "llm_calls の記録に失敗しました",
      );
      throw new LlmCallError(
        "permanent",
        attemptNo,
        `llm_calls の記録に失敗しました: ${reason}`,
        httpStatus,
      );
    }

    if (succeeded) return outcome.value as T;

    const kind = classified.kind ?? "permanent";
    if (!classified.retry || attemptNo >= max_attempts) {
      throw new LlmCallError(kind, attemptNo, errorText ?? "unknown error", httpStatus);
    }
    deps.logger.warn(
      { model, attempt: attemptNo, kind, httpStatus, delayMs: classified.delayMs },
      "LLM 呼び出しを再試行します",
    );
    try {
      await sleep(classified.delayMs ?? 0, callerSignal);
    } catch {
      throw new LlmCallError("aborted", attemptNo, "呼び出し元が取り消しました");
    }
  }
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** トークン数。usage が返らなかった（0/0）ときは記録しない */
function tokenUsage(message: AssistantMessage): TokenUsage | undefined {
  const { input, output } = message.usage;
  return input === 0 && output === 0 ? undefined : { input, output };
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  extra_content?: unknown;
}

/**
 * 応答のチャンクから、ツール呼び出しごとの extra_content を覚える。
 * Gemini（開発用の Google AI Studio）は thought_signature をここに入れ、次の要求で送り返さないと 400 になる。
 * Pi の openai-completions はこの項目を保持しないので、ゲートで往復させる。さくらは返さないので影響しない。
 */
export function rememberToolCallExtras(
  chunk: unknown,
  indexToId: Map<number, string>,
  extras: Map<string, unknown>,
): void {
  const choices = (chunk as { choices?: { delta?: { tool_calls?: RawToolCallDelta[] } }[] })
    ?.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = typeof call.index === "number" ? call.index : 0;
      if (typeof call.id === "string" && call.id !== "") indexToId.set(index, call.id);
      const id = indexToId.get(index);
      if (id !== undefined && call.extra_content !== undefined) extras.set(id, call.extra_content);
    }
  }
}

/** 要求の本文の assistant の tool_calls に、覚えておいた extra_content を戻す */
export function restoreToolCallExtras(payload: unknown, extras: Map<string, unknown>): unknown {
  if (extras.size === 0) return payload;
  const messages = (payload as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return payload;
  for (const message of messages as { role?: string; tool_calls?: RawToolCallDelta[] }[]) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const extra = call.id === undefined ? undefined : extras.get(call.id);
      if (extra !== undefined && call.extra_content === undefined) call.extra_content = extra;
    }
  }
  return payload;
}

/**
 * pi-agent-core の StreamFn。内側の models.streamSimple を runGated で包む。
 * 内側のイベントは最後まで溜め、成功した試行のイベントだけを流す（途中までの応答は流さない。research R7）。
 * 失敗時は error イベント1つ（errorMessage はマスク済み。予算切れは budget_exceeded:... の形）。
 */
export function createGatedStreamFn(deps: GateDeps, ctx: CallContext): StreamFn {
  // ツール呼び出しの id → extra_content。StreamFn（Agent）ごとに持ち、会話の往復で使う
  const toolCallExtras = new Map<string, unknown>();
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const timeoutMs = deps.config.llm.request_timeout_seconds * 1000;

    const run = async () => {
      try {
        const events = await runGated<AssistantMessageEvent[]>(
          deps,
          ctx,
          model.id,
          async (signal, fetchFn) => {
            const indexToId = new Map<number, string>();
            const inner = deps.models.streamSimple(model, context, {
              ...options,
              onProviderStreamEvent: async (data, eventModel) => {
                rememberToolCallExtras(data, indexToId, toolCallExtras);
                await options?.onProviderStreamEvent?.(data, eventModel);
              },
              onPayload: async (payload, payloadModel) => {
                const next = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
                return restoreToolCallExtras(next, toolCallExtras);
              },
              ...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }),
              maxRetries: 0,
              fetch: fetchFn,
              signal,
              timeoutMs,
            });
            const collected: AssistantMessageEvent[] = [];
            for await (const event of inner) collected.push(event);
            const last = collected.at(-1);
            if (last?.type === "done") {
              const usage = tokenUsage(last.message);
              return { ok: true, value: collected, ...(usage ? { usage } : {}) };
            }
            const failed = last?.type === "error" ? last.error : undefined;
            const usage = failed ? tokenUsage(failed) : undefined;
            return {
              ok: false,
              message:
                failed?.errorMessage ?? "LLM のストリームが done も error もなく終わりました",
              ...(usage ? { usage } : {}),
            };
          },
          options?.signal ? { signal: options.signal } : {},
        );
        for (const event of events) out.push(event);
        out.end();
      } catch (error) {
        const aborted = error instanceof LlmCallError && error.kind === "aborted";
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: aborted ? "aborted" : "error",
          errorMessage:
            error instanceof Error
              ? error.message
              : maskError(String(error), deps.apiKey ?? process.env[apiKeyEnvOf(deps.config)]),
          timestamp: (deps.now ?? Date.now)(),
        };
        out.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
        out.end();
      }
    };
    void run();
    return out;
  };
}

/** ゲートが返した最終メッセージが予算切れなら取り出す（007 が failed への遷移に使う） */
export function getBudgetExceeded(message: AssistantMessage): BudgetExceededError | undefined {
  return message.stopReason === "error" ? parseBudgetExceeded(message.errorMessage) : undefined;
}

/**
 * pi-agent-core の既定の StreamFn に「ゲートを通さずに呼ばれたら例外」を設定する。
 * Agent に streamFn を渡し忘れても、素の LLM 呼び出しにならないようにする。main.ts とスモークテストの起動時に呼ぶ。
 */
export function installStreamFnGuard(): void {
  setDefaultStreamFn(() => {
    throw new Error(GUARD_MESSAGE);
  });
}

export type { Model };
