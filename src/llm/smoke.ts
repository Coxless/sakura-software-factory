/**
 * さくらのAI Engine の実機スモークテストの確認項目（002 FR-021〜026、research R14・R15）。
 * CLI（src/smoke-llm.ts）から分け、偽の LLM でテストできるようにしている。
 * Pi 経由（pi）と、Pi を通さない素の HTTP（raw: ストリーミング、raw-nostream: stream: false）の3通りで、
 * 同じ3つの要求（ツールなし → ツールあり → ツールの結果を返して続き）を送る。どの経路も予算ゲートを通る。
 */
import {
  type AssistantMessage,
  type Context,
  type Message,
  normalizeContext,
  type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
import { gt, max } from "drizzle-orm";
import Type from "typebox";
import Value from "typebox/value";
import { type LlmRole, llmCalls } from "../queue/schema.ts";
import {
  apiKeyEnvOf,
  createLlmModels,
  DEFAULT_SAKURA_COMPAT,
  type ModelRole,
  modelForRole,
  providerOf,
} from "./provider.ts";
import {
  type AttemptOutcome,
  type CallContext,
  createGatedStreamFn,
  type GateDeps,
  maskError,
  runGated,
  type TokenUsage,
} from "./stream.ts";

export type SmokeMode = "pi" | "raw" | "raw-nostream";
export type SmokeCheckId = "a" | "b" | "c" | "d" | "e" | "f";

export interface SmokeCheck {
  id: SmokeCheckId;
  name: string;
  passed: boolean;
  /** 不合格のとき、マスク済みのモデルの出力 */
  detail?: string;
}

export interface SmokeReport {
  /** 提供元（sakura / google-ai-studio） */
  provider: string;
  model: string;
  mode: SmokeMode;
  /** 使った互換フラグ（pi のときだけ） */
  compat?: OpenAICompletionsCompat;
  checks: SmokeCheck[];
  /** 送ったリクエスト数（llm_calls に記録した件数と一致） */
  requests: number;
  passed: boolean;
}

export interface SmokeOptions {
  role: ModelRole;
  mode: SmokeMode;
  /** 互換フラグの一時的な上書き（pi だけ） */
  compat?: Partial<OpenAICompletionsCompat>;
}

/** 実行の途中で LLM 呼び出しが失敗した（予算切れ・恒久的なエラー・再試行の上限） */
export class SmokeError extends Error {
  readonly requests: number;

  constructor(message: string, requests: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SmokeError";
    this.requests = requests;
  }
}

export const CHECK_NAMES: Record<SmokeCheckId, string> = {
  a: "テキストの応答が返る",
  b: "ツール呼び出しが構造化されて返る",
  c: "引数がツールの定義に合う",
  d: "ツール結果のあとに続きの応答が返る",
  e: "本文にツール呼び出しの記法が漏れていない",
  f: "入出力トークン数が取れる",
};

/** 1回の実行で送るリクエストの上限（FR-022） */
export const SMOKE_MAX_REQUESTS = 10;
/** 3要求 × 3回 = 9 ≤ 10 に収めるための、スモークテストでの試行回数の上限 */
const SMOKE_MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = "あなたは動作確認用のアシスタントです。簡潔に日本語で答えてください。";
const PROMPT_TEXT = "pong とだけ答えてください。";
const PROMPT_TOOL = "東京の天気を get_weather ツールで調べてください。";
const TOOL_RESULT = { weather: "晴れ" };

export const WeatherArgs = Type.Object(
  { city: Type.String({ minLength: 1, description: "都市名（例: 東京）" }) },
  { additionalProperties: false },
);
const WEATHER_TOOL = {
  name: "get_weather",
  description: "指定した都市の今日の天気を返す",
  parameters: WeatherArgs,
};

/** ツール呼び出しの記法が本文に漏れていないか（`03` 6章） */
const LEAK_PATTERNS = [
  /<\/?tool_call/i,
  /<\|tool_calls?/i,
  /<\|tool▁call/i,
  /<function=/i,
  /\[TOOL_CALLS\]/,
  /"name"\s*:\s*"get_weather"/,
];

const DETAIL_LIMIT = 600;

/** 経路によらない、1回の応答の中身 */
interface SmokeResponse {
  text: string;
  toolCalls: { id: string; name: string; args: unknown; argsText: string }[];
  usage?: TokenUsage;
}

/** モデル名から記録の役割を決める（verifier_alt は検査役、fallback は実装役の代わり） */
function recordRole(role: ModelRole): LlmRole {
  if (role === "verifier_alt") return "verifier";
  if (role === "fallback") return "implementer";
  return role;
}

function lastCallId(deps: GateDeps): number {
  return (
    deps.db
      .select({ id: max(llmCalls.id) })
      .from(llmCalls)
      .get()?.id ?? 0
  );
}

function countSince(deps: GateDeps, sinceId: number): number {
  return deps.db.select({ id: llmCalls.id }).from(llmCalls).where(gt(llmCalls.id, sinceId)).all()
    .length;
}

// ---- Pi 経由 ----

function fromAssistant(message: AssistantMessage): SmokeResponse {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      name: block.name,
      args: block.arguments,
      argsText: JSON.stringify(block.arguments),
    }));
  const { input, output } = message.usage;
  return {
    text,
    toolCalls,
    ...(input === 0 && output === 0 ? {} : { usage: { input, output } }),
  };
}

function piSender(deps: GateDeps, ctx: CallContext, role: ModelRole) {
  const model = modelForRole(deps.models, deps.config, role);
  const streamFn = createGatedStreamFn(deps, ctx);
  const history: Message[] = [];
  const now = deps.now ?? Date.now;

  const send = async (
    context: Context,
  ): Promise<{ response: SmokeResponse; raw: AssistantMessage }> => {
    const stream = await streamFn(model, normalizeContext(context), {});
    const message = await stream.result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "LLM 呼び出しに失敗しました");
    }
    return { response: fromAssistant(message), raw: message };
  };

  return {
    modelId: model.id,
    async text() {
      return (
        await send({
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: "user", content: PROMPT_TEXT, timestamp: now() }],
        })
      ).response;
    },
    async tool() {
      history.push({ role: "user", content: PROMPT_TOOL, timestamp: now() });
      const { response, raw } = await send({
        systemPrompt: SYSTEM_PROMPT,
        messages: [...history],
        tools: [WEATHER_TOOL],
      });
      history.push(raw);
      return response;
    },
    async afterTool(call: SmokeResponse["toolCalls"][number]) {
      history.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: JSON.stringify(TOOL_RESULT) }],
        isError: false,
        timestamp: now(),
      });
      return (
        await send({ systemPrompt: SYSTEM_PROMPT, messages: [...history], tools: [WEATHER_TOOL] })
      ).response;
    },
  };
}

// ---- 素の HTTP ----

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function toUsage(usage: ChatChunk["usage"]): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return input === 0 && output === 0 ? undefined : { input, output };
}

function parseArgs(argsText: string): unknown {
  try {
    return JSON.parse(argsText || "{}");
  } catch {
    return undefined;
  }
}

/** SSE の本文から、本文・ツール呼び出し（index ごとに引数をつなぐ）・usage を組み立てる */
export function parseChatSse(body: string): SmokeResponse {
  let text = "";
  let usage: TokenUsage | undefined;
  const calls = new Map<number, { id: string; name: string; argsText: string }>();
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data) as ChatChunk;
    usage = toUsage(chunk.usage) ?? usage;
    for (const choice of chunk.choices ?? []) {
      if (choice.delta?.content) text += choice.delta.content;
      for (const delta of choice.delta?.tool_calls ?? []) {
        const index = delta.index ?? 0;
        const current = calls.get(index) ?? { id: "", name: "", argsText: "" };
        if (delta.id) current.id = delta.id;
        if (delta.function?.name) current.name += delta.function.name;
        if (delta.function?.arguments) current.argsText += delta.function.arguments;
        calls.set(index, current);
      }
    }
  }
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({ ...call, args: parseArgs(call.argsText) }));
  return { text, toolCalls, ...(usage ? { usage } : {}) };
}

/** chat.completion の JSON から、本文・ツール呼び出し・usage を取り出す */
export function parseChatJson(body: ChatChunk): SmokeResponse {
  const message = body.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls ?? []).map((call) => ({
    id: call.id ?? "",
    name: call.function?.name ?? "",
    argsText: call.function?.arguments ?? "",
    args: parseArgs(call.function?.arguments ?? ""),
  }));
  const usage = toUsage(body.usage);
  return { text: message?.content ?? "", toolCalls, ...(usage ? { usage } : {}) };
}

function rawSender(deps: GateDeps, ctx: CallContext, role: ModelRole, stream: boolean) {
  const model = modelForRole(deps.models, deps.config, role);
  const apiKey = deps.apiKey ?? process.env[apiKeyEnvOf(deps.config)] ?? "";
  const url = `${deps.config.llm.base_url.replace(/\/+$/, "")}/chat/completions`;
  const tools = [
    {
      type: "function",
      function: {
        name: WEATHER_TOOL.name,
        description: WEATHER_TOOL.description,
        parameters: JSON.parse(JSON.stringify(WeatherArgs)),
      },
    },
  ];
  const history: unknown[] = [{ role: "system", content: SYSTEM_PROMPT }];

  const send = (messages: unknown[], withTools: boolean) =>
    runGated<SmokeResponse>(
      deps,
      ctx,
      model.id,
      async (signal, fetchFn): Promise<AttemptOutcome<SmokeResponse>> => {
        const body: Record<string, unknown> = { model: model.id, messages, stream };
        if (stream) body.stream_options = { include_usage: true };
        if (withTools) body.tools = tools;
        const response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        const text = await response.text();
        if (!response.ok) return { ok: false, message: `${response.status} ${text}` };
        const parsed = stream ? parseChatSse(text) : parseChatJson(JSON.parse(text) as ChatChunk);
        return { ok: true, value: parsed, ...(parsed.usage ? { usage: parsed.usage } : {}) };
      },
    );

  return {
    modelId: model.id,
    text: () => send([...history, { role: "user", content: PROMPT_TEXT }], false),
    async tool() {
      history.push({ role: "user", content: PROMPT_TOOL });
      const response = await send([...history], true);
      history.push({
        role: "assistant",
        content: response.text || null,
        ...(response.toolCalls.length > 0
          ? {
              tool_calls: response.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.argsText },
              })),
            }
          : {}),
      });
      return response;
    },
    afterTool(call: SmokeResponse["toolCalls"][number]) {
      history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(TOOL_RESULT) });
      return send([...history], true);
    },
  };
}

// ---- 判定 ----

function detailOf(response: SmokeResponse | undefined, apiKey: string | undefined): string {
  if (!response) return "応答なし";
  const shown = JSON.stringify({
    text: response.text,
    toolCalls: response.toolCalls.map((call) => ({ name: call.name, arguments: call.argsText })),
  });
  const masked = maskError(shown, apiKey);
  return masked.length > DETAIL_LIMIT ? `${masked.slice(0, DETAIL_LIMIT)}…` : masked;
}

function leaks(text: string): boolean {
  return LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

/** 確認項目 (a)〜(f) を実行する。LLM 呼び出しが失敗したら SmokeError を投げる */
export async function runSmoke(deps: GateDeps, options: SmokeOptions): Promise<SmokeReport> {
  const compat =
    options.mode === "pi" ? { ...DEFAULT_SAKURA_COMPAT, ...options.compat } : undefined;
  const smokeDeps: GateDeps = {
    ...deps,
    config: {
      ...deps.config,
      llm: {
        ...deps.config.llm,
        max_attempts: Math.min(deps.config.llm.max_attempts, SMOKE_MAX_ATTEMPTS),
      },
    },
    ...(options.mode === "pi" && options.compat
      ? { models: createLlmModels(deps.config, { compat: options.compat }) }
      : {}),
  };
  const ctx: CallContext = { jobId: null, phase: "smoke", role: recordRole(options.role) };
  const apiKey = deps.apiKey ?? process.env[apiKeyEnvOf(deps.config)];
  const sender =
    options.mode === "pi"
      ? piSender(smokeDeps, ctx, options.role)
      : rawSender(smokeDeps, ctx, options.role, options.mode === "raw");
  const sinceId = lastCallId(deps);
  const requests = () => countSince(deps, sinceId);

  const step = async <T>(run: () => Promise<T>): Promise<T> => {
    if (requests() >= SMOKE_MAX_REQUESTS) {
      throw new SmokeError(
        `1回の実行のリクエスト上限（${SMOKE_MAX_REQUESTS}件）に達しました`,
        requests(),
      );
    }
    try {
      return await run();
    } catch (error) {
      const message = maskError(error instanceof Error ? error.message : String(error), apiKey);
      throw new SmokeError(message, requests(), { cause: error });
    }
  };

  // 1. ツールなし
  const first = await step(() => sender.text());
  // 2. ツールあり
  const second = await step(() => sender.tool());
  const call = second.toolCalls.find((candidate) => candidate.name === WEATHER_TOOL.name);
  // 3. ツールの結果を返して続き（ツール呼び出しがなければ送らない）
  const third = call ? await step(() => sender.afterTool(call)) : undefined;

  const argsOk = call !== undefined && Value.Check(WeatherArgs, call.args);
  const leaked = [second, third].some((response) => response && leaks(response.text));
  const responses = [first, second, third].filter((response) => response !== undefined);
  const checks: SmokeCheck[] = [
    { id: "a", passed: first.text.trim().length > 0, detail: detailOf(first, apiKey) },
    { id: "b", passed: call !== undefined, detail: detailOf(second, apiKey) },
    { id: "c", passed: argsOk, detail: detailOf(second, apiKey) },
    {
      id: "d",
      passed: third !== undefined && third.text.trim().length > 0,
      detail: third
        ? detailOf(third, apiKey)
        : "ツール呼び出しが返らなかったため、続きを確かめていない",
    },
    {
      id: "e",
      passed: !leaked,
      detail: [second, third].map((response) => detailOf(response, apiKey)).join("\n"),
    },
    {
      id: "f",
      passed: responses.every((response) => response.usage !== undefined),
      detail: responses.map((response) => JSON.stringify(response.usage ?? null)).join(", "),
    },
  ].map((check) => {
    const { detail, ...rest } = check;
    const named = { ...rest, name: CHECK_NAMES[check.id as SmokeCheckId] } as SmokeCheck;
    return check.passed ? named : { ...named, detail };
  });

  return {
    provider: providerOf(deps.config).id,
    model: sender.modelId,
    mode: options.mode,
    ...(compat ? { compat } : {}),
    checks,
    requests: requests(),
    passed: checks.every((check) => check.passed),
  };
}
