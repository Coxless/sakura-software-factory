/**
 * ツールなしの1回呼び出し（005 research R1）。計画役・検査役が使う。
 * 002 の予算ゲート（createGatedStreamFn）をそのまま通し、context に tools を入れない（原則 III）。
 * 入口と結果の型は Pi の型を含まない。例外を投げない。
 */
import { type AssistantMessage, type Message, normalizeContext } from "@earendil-works/pi-ai";
import { apiKeyEnvOf, type ModelRole, modelForRole } from "./provider.ts";
import {
  type CallContext,
  createGatedStreamFn,
  type GateDeps,
  getBudgetExceeded,
} from "./stream.ts";

export interface CompletionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CompletionRequest {
  role: ModelRole;
  systemPrompt: string;
  messages: readonly CompletionMessage[];
  signal?: AbortSignal;
}

export interface CompletionResult {
  ok: boolean;
  text: string;
  /** 出力の上限で切れた */
  truncated: boolean;
  usage?: { input: number; output: number };
  /** マスク済み（ゲートがマスクしたもの） */
  error?: string;
  budgetExceeded: boolean;
  aborted: boolean;
  /** 呼んだモデルの ID（モデルを引けなかったら空） */
  model: string;
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

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 予算ゲートを通し、tools を渡さずに1回呼ぶ。例外を投げない */
export async function completeOnce(
  gate: GateDeps,
  ctx: CallContext,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const now = gate.now ?? Date.now;
  let modelId = "";
  try {
    const model = modelForRole(gate.models, gate.config, req.role);
    modelId = model.id;
    const messages: Message[] = req.messages.map((message) =>
      message.role === "user"
        ? { role: "user", content: message.text, timestamp: now() }
        : {
            role: "assistant",
            content: [{ type: "text", text: message.text }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: "stop",
            timestamp: now(),
          },
    );
    const streamFn = createGatedStreamFn(gate, ctx);
    // tools は渡さない（原則 III。tool_choice の扱いがモデルごとに違うため、定義そのものを送らない）
    const stream = await streamFn(
      model,
      normalizeContext({ systemPrompt: req.systemPrompt, messages }),
      req.signal ? { signal: req.signal } : {},
    );
    const message = await stream.result();
    const { input, output } = message.usage;
    const usage = input === 0 && output === 0 ? {} : { usage: { input, output } };
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        ok: false,
        text: "",
        truncated: false,
        ...usage,
        error: message.errorMessage ?? "LLM の呼び出しに失敗しました",
        budgetExceeded: getBudgetExceeded(message) !== undefined,
        aborted: message.stopReason === "aborted",
        model: modelId,
      };
    }
    return {
      ok: true,
      text: textOf(message),
      truncated: message.stopReason === "length",
      ...usage,
      budgetExceeded: false,
      aborted: false,
      model: modelId,
    };
  } catch (error) {
    const apiKey = gate.apiKey ?? process.env[apiKeyEnvOf(gate.config)];
    let text = errorText(error);
    if (apiKey) text = text.split(apiKey).join("[REDACTED]");
    return {
      ok: false,
      text: "",
      truncated: false,
      error: text,
      budgetExceeded: false,
      aborted: req.signal?.aborted === true,
      model: modelId,
    };
  }
}
