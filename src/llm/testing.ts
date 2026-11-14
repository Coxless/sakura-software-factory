/**
 * テスト専用: 偽の LLM（OpenAI互換の応答を返す偽の fetch）と、予算ゲートのテスト用の依存。
 * 本物の さくらの提供元と openai-completions のアダプターはそのまま通し、ネットワークの手前だけを差し替える
 * （002 research R13）。自動テストで さくらのAI Engine を呼ばないために、LLM を使うテストはすべてこれを使う。
 */
import { parseConfig } from "../config.ts";
import { createLogger } from "../log.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { createLlmModels } from "./provider.ts";
import type { GateDeps } from "./stream.ts";

export interface FakeUsage {
  input: number;
  output: number;
}

/** 偽の LLM に仕込む応答。1回の fetch に1つずつ、仕込んだ順に返す */
export type FakeResponse =
  /** テキストの応答。usage を省くと usage を返さない（スモークテストの (f) の不合格を再現する） */
  | { text: string; usage?: FakeUsage }
  /**
   * ツール呼び出し。ストリーミングでは引数の JSON を2つの delta に分けて返す。
   * id を省くと call_fake_1。1つの応答で複数を呼ぶときは toolCalls（id は call_fake_1, call_fake_2, …）
   */
  | {
      toolCall: FakeToolCall;
      /** ツール呼び出しに付ける extra_content（Gemini の thought_signature の再現） */
      extraContent?: Record<string, unknown>;
      text?: string;
      usage?: FakeUsage;
    }
  /** 1つの応答で複数のツールを呼ぶ（004） */
  | { toolCalls: FakeToolCall[]; text?: string; usage?: FakeUsage }
  /** HTTP エラー（429・500・401 など）。retryAfterSeconds で retry-after ヘッダーを付ける */
  | {
      httpError: number;
      retryAfterSeconds?: number;
      body?: string;
      headers?: Record<string, string>;
    }
  /** 接続失敗（fetch が TypeError を投げる） */
  | { networkError: string }
  /** 200 のあと、SSE を数チャンク流してから本文のストリームをエラーにする */
  | { midStreamError: string }
  /** 応答を返さず、要求の signal が中止されるまで待つ（タイムアウト・取り消しのテスト） */
  | { hang: true };

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

type FakeAnswer = Extract<
  FakeResponse,
  { text: string } | { toolCall: unknown } | { toolCalls: unknown }
>;

/** 応答のツール呼び出しの一覧（id を決めたもの）。extraContent は1つ目だけに付ける */
function toolCallsOf(
  response: FakeAnswer,
): { id: string; call: FakeToolCall; extra?: Record<string, unknown> }[] {
  if ("toolCalls" in response) {
    return response.toolCalls.map((call, i) => ({ id: call.id ?? `call_fake_${i + 1}`, call }));
  }
  if ("toolCall" in response) {
    return [
      {
        id: response.toolCall.id ?? "call_fake_1",
        call: response.toolCall,
        ...(response.extraContent ? { extra: response.extraContent } : {}),
      },
    ];
  }
  return [];
}

export interface FakeRequest {
  url: string;
  model: string;
  messages: unknown[];
  tools?: unknown[];
  stream: boolean;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface FakeLlm {
  /** GateDeps.fetch に渡す */
  fetch: typeof fetch;
  /** 受け取った要求（応答を返した順） */
  requests: FakeRequest[];
  /** 残りの仕込みの数 */
  remaining(): number;
}

export const FAKE_EXHAUSTED_MESSAGE = "fake LLM: no more responses";

const encoder = new TextEncoder();

function sseChunk(model: string, choice: unknown, usage?: unknown): string {
  const payload: Record<string, unknown> = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: choice === undefined ? [] : [choice],
  };
  if (usage !== undefined) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function openAiUsage(usage: FakeUsage) {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
  };
}

/** テキスト・ツール呼び出しの応答を SSE のチャンク列にする */
function sseEvents(response: FakeAnswer, model: string): string[] {
  const events: string[] = [];
  const text = response.text;
  const calls = toolCallsOf(response);
  events.push(
    sseChunk(model, { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }),
  );
  if (text) {
    // 2つに分けて流す（逐次の組み立てを通す）
    const half = Math.ceil(text.length / 2);
    for (const part of [text.slice(0, half), text.slice(half)]) {
      if (part) {
        events.push(sseChunk(model, { index: 0, delta: { content: part }, finish_reason: null }));
      }
    }
  }
  for (const [index, { id, call, extra }] of calls.entries()) {
    const args = JSON.stringify(call.args);
    const half = Math.ceil(args.length / 2);
    events.push(
      sseChunk(model, {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id,
              type: "function",
              function: { name: call.name, arguments: args.slice(0, half) },
              ...(extra ? { extra_content: extra } : {}),
            },
          ],
        },
        finish_reason: null,
      }),
    );
    events.push(
      sseChunk(model, {
        index: 0,
        delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] },
        finish_reason: null,
      }),
    );
  }
  events.push(
    sseChunk(model, {
      index: 0,
      delta: {},
      finish_reason: calls.length > 0 ? "tool_calls" : "stop",
    }),
  );
  if (response.usage) events.push(sseChunk(model, undefined, openAiUsage(response.usage)));
  events.push("data: [DONE]\n\n");
  return events;
}

/** テキスト・ツール呼び出しの応答を chat.completion の JSON にする（stream: false 用） */
function jsonCompletion(response: FakeAnswer, model: string) {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: response.text ?? null,
  };
  const calls = toolCallsOf(response);
  if (calls.length > 0) {
    message.tool_calls = calls.map(({ id, call, extra }) => ({
      id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
      ...(extra ? { extra_content: extra } : {}),
    }));
  }
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }],
    ...(response.usage ? { usage: openAiUsage(response.usage) } : {}),
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function headersToRecord(headers: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

/**
 * 仕込んだ応答を順に返す偽の fetch。
 * 要求の本文の `stream` が true なら SSE、false なら JSON を返す。仕込みが尽きたら fetch 自体が例外を投げる。
 */
export function createFakeLlm(
  responses: FakeResponse[],
  hooks: { onHang?: () => void } = {},
): FakeLlm {
  const queue = [...responses];
  const requests: FakeRequest[] = [];

  const fakeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const next = queue.shift();
    if (next === undefined) throw new Error(FAKE_EXHAUSTED_MESSAGE);

    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const model = String(body.model);
    const stream = body.stream === true;
    requests.push({
      url,
      model,
      messages: (body.messages as unknown[]) ?? [],
      ...(body.tools === undefined ? {} : { tools: body.tools as unknown[] }),
      stream,
      body,
      headers: headersToRecord(init?.headers),
    });

    if ("networkError" in next) throw new TypeError(next.networkError);

    if ("hang" in next) {
      return new Promise<Response>((_, reject) => {
        if (!signal) return;
        signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
        hooks.onHang?.();
      });
    }

    if ("httpError" in next) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...next.headers,
      };
      if (next.retryAfterSeconds !== undefined) {
        headers["retry-after"] = String(next.retryAfterSeconds);
      }
      const errorBody =
        next.body ??
        JSON.stringify({ error: { message: `fake error ${next.httpError}`, type: "fake" } });
      return new Response(errorBody, { status: next.httpError, headers });
    }

    if ("midStreamError" in next) {
      const first = sseChunk(model, {
        index: 0,
        delta: { role: "assistant", content: "途中まで" },
        finish_reason: null,
      });
      const failure = new TypeError(next.midStreamError);
      const sse = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(first));
        },
        pull(controller) {
          controller.error(failure);
        },
      });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    if (!stream) {
      return new Response(JSON.stringify(jsonCompletion(next, model)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const events = sseEvents(next, model);
    const sse = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  return {
    fetch: fakeFetch as typeof fetch,
    requests,
    remaining: () => queue.length,
  };
}

export interface TestConfigOverrides {
  llm?: Partial<{
    max_attempts: number;
    max_retry_delay_seconds: number;
    request_timeout_seconds: number;
  }>;
  budget?: Partial<{ monthly_requests: number; per_job_requests: number; timezone: string }>;
  /** [limits] の一部（004） */
  limits?: Partial<{
    max_turns_per_phase: number;
    job_timeout_minutes: number;
    judge_retries: number;
  }>;
  /** [models] の一部（005: 検査役と実装役を同じにするテスト） */
  models?: Partial<{
    planner: string;
    implementer: string;
    verifier: string;
    verifier_alt: string;
  }>;
  /** [pipeline] の一部（005） */
  pipeline?: Partial<{
    check_commands: string[];
    check_timeout_seconds: number;
    max_check_feedbacks: number;
    max_check_log_chars: number;
    max_diff_chars: number;
    max_file_list_chars: number;
  }>;
  /** [implementer] の一部（004） */
  implementer?: Partial<{
    max_consecutive_blocks: number;
    compaction_ratio: number;
    keep_recent_turns: number;
    max_agents_md_chars: number;
    max_issue_chars: number;
    max_plan_chars: number;
    max_feedback_chars: number;
  }>;
  /** [storage] の一部（004 の軌跡のテスト） */
  storage?: Partial<{ trace_dir: string; eval_dir: string }>;
}

export const TEST_API_KEY = "test-key-ABCDEF123";
export const TEST_BASE_URL = "https://sakura.test/v1";
/** テストの既定の時刻（2026-11-10 09:00 JST） */
export const TEST_NOW = Date.parse("2026-11-10T00:00:00Z");

function tomlTable(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");
}

function optionalTable(name: string, values: Record<string, unknown> | undefined): string {
  return values === undefined ? "" : `[${name}]\n${tomlTable(values)}\n`;
}

/** テスト用の設定。上限などを一部だけ上書きできる */
export function testConfig(overrides: TestConfigOverrides = {}) {
  const monthly = overrides.budget?.monthly_requests ?? 3000;
  const budget = {
    monthly_requests: monthly,
    per_job_requests: Math.min(100, monthly),
    timezone: "Asia/Tokyo",
    ...overrides.budget,
  };
  return parseConfig(
    `
[llm]
${tomlTable({ base_url: TEST_BASE_URL, ...overrides.llm })}

[models]
${tomlTable({
  planner: "plan-model",
  implementer: "impl-model",
  verifier: "verify-model",
  fallback: "fallback-model",
  ...overrides.models,
})}

[budget]
${tomlTable(budget)}

[github]
allowed_users = ["tester"]
${optionalTable("limits", overrides.limits)}
${optionalTable("implementer", overrides.implementer)}
${optionalTable("storage", overrides.storage)}
${optionalTable("pipeline", overrides.pipeline)}
`,
    "/tmp",
  );
}

/**
 * 予算ゲートのテスト用の依存一式: マイグレーション済みの :memory: の DB、本物の createLlmModels、
 * 偽の fetch、待たない sleep（待とうとした時間は sleeps に残る）、動かせる時計、手動で発火できる時間の上限。
 * `{ hang: true }` を仕込むと、その要求が届いた時点で時間の上限が発火する（onHang で差し替えられる）。
 */
export function createTestGateDeps(
  options: {
    responses?: FakeResponse[];
    config?: TestConfigOverrides;
    /** `{ hang: true }` の要求が届いたときの動き。既定は時間の上限を発火する */
    onHang?: () => void;
  } = {},
) {
  const handle = migratedMemoryDb();
  const config = testConfig(options.config);
  const sleeps: number[] = [];
  let now = TEST_NOW;
  const timeouts = new Set<AbortController>();

  const fireTimeout = () => {
    for (const controller of timeouts) {
      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    }
    timeouts.clear();
  };
  const fake = createFakeLlm(options.responses ?? [], {
    onHang: () => queueMicrotask(options.onHang ?? fireTimeout),
  });

  const deps: GateDeps = {
    db: handle.db,
    config,
    models: createLlmModels(config),
    logger: createLogger({ level: "fatal" }),
    apiKey: TEST_API_KEY,
    fetch: fake.fetch,
    now: () => now,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal?.aborted) throw signal.reason;
    },
    timeoutSignal: () => {
      const controller = new AbortController();
      timeouts.add(controller);
      return controller.signal;
    },
  };

  return {
    deps,
    fake,
    db: handle.db,
    sqlite: handle.sqlite,
    close: handle.close,
    sleeps,
    fireTimeout,
    setNow: (value: number) => {
      now = value;
    },
  };
}
