import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
  type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { FactoryConfig, LlmProviderId } from "../config.ts";
import type { LlmRole } from "../queue/schema.ts";

export const SAKURA_PROVIDER_ID = "sakura";
export const SAKURA_API_KEY_ENV = "SAKURA_AI_API_KEY";
export const GOOGLE_AI_STUDIO_API_KEY_ENV = "GEMINI_API_KEY";

export interface LlmProvider {
  id: LlmProviderId;
  name: string;
  /** APIキーを読む環境変数 */
  apiKeyEnv: string;
}

/**
 * 提供元の一覧。本番の推論は さくら だけ（constitution 原則 I）。
 * google-ai-studio は開発中の動作確認だけに使い、公開してよいデータだけを送る（無償枠の入出力は Google の学習に使われる）。
 */
export const LLM_PROVIDERS: Record<LlmProviderId, LlmProvider> = {
  sakura: { id: "sakura", name: "さくらのAI Engine", apiKeyEnv: SAKURA_API_KEY_ENV },
  "google-ai-studio": {
    id: "google-ai-studio",
    name: "Google AI Studio（開発用）",
    apiKeyEnv: GOOGLE_AI_STUDIO_API_KEY_ENV,
  },
};

export function providerOf(config: FactoryConfig): LlmProvider {
  return LLM_PROVIDERS[config.llm.provider];
}

/** 設定の提供元の APIキーの環境変数名 */
export function apiKeyEnvOf(config: FactoryConfig): string {
  return providerOf(config).apiKeyEnv;
}

/** 常駐するファクトリーは さくら以外の提供元では起動しない（原則 I）。main.ts の起動時に呼ぶ */
export function assertProductionProvider(config: FactoryConfig): void {
  if (config.llm.provider !== "sakura") {
    throw new Error(
      `[llm].provider = "${config.llm.provider}" は開発用です。常駐するファクトリーは provider = "sakura" でだけ起動します（constitution 原則 I）`,
    );
  }
}

/**
 * さくらのAI Engine 向けの互換フラグ（002 research R3）。Google AI Studio の OpenAI 互換にも同じ値で送る。
 * OpenAI 本家の既定（developer ロール、max_completion_tokens など）で送らないようにする。
 * スモークテストの結果で直す。
 */
export const DEFAULT_SAKURA_COMPAT: OpenAICompletionsCompat = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStore: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
};

/** さくらの公開値が分からないため仮の値で始める。スモークテストで分かったら直す */
const CONTEXT_WINDOW = 131072;
const MAX_TOKENS = 8192;

/** 役割に加えて、スモークテストで選べる設定の項目 */
export type ModelRole = LlmRole | "verifier_alt" | "fallback";

export interface SakuraModelsOptions {
  /** 互換フラグを一部だけ上書きする（スモークテストの --compat） */
  compat?: Partial<OpenAICompletionsCompat>;
}

/** 設定の提供元（既定は さくら）を登録した Models。factory.toml の [models] の全モデルを持つ */
export function createLlmModels(config: FactoryConfig, options: SakuraModelsOptions = {}): Models {
  const provider = providerOf(config);
  const compat = { ...DEFAULT_SAKURA_COMPAT, ...options.compat };
  const ids = [...new Set(Object.values(config.models).filter((id) => id !== undefined))];
  const models: Model<"openai-completions">[] = ids.map((id) => ({
    id,
    name: id,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: config.llm.base_url,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    compat,
  }));
  const registry = createModels();
  registry.setProvider(
    createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: config.llm.base_url,
      auth: { apiKey: envApiKeyAuth(provider.name, [provider.apiKeyEnv]) },
      models,
      api: openAICompletionsApi(),
    }),
  );
  return registry;
}

/** 役割 → factory.toml のモデル名 → Model。退避先への自動切り替えはしない */
export function modelForRole(
  models: Models,
  config: FactoryConfig,
  role: ModelRole,
): Model<"openai-completions"> {
  const id = config.models[role];
  if (id === undefined) {
    throw new Error(`factory.toml の [models].${role} が設定されていません`);
  }
  const provider = providerOf(config);
  const model = models.getModel(provider.id, id);
  if (model === undefined || model.api !== "openai-completions") {
    throw new Error(
      `モデル ${id}（[models].${role}）が ${provider.name} の提供元に登録されていません`,
    );
  }
  return model as Model<"openai-completions">;
}
