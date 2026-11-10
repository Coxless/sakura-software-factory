import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
  type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { FactoryConfig } from "../config.ts";
import type { LlmRole } from "../queue/schema.ts";

export const SAKURA_PROVIDER_ID = "sakura";
export const SAKURA_API_KEY_ENV = "SAKURA_AI_API_KEY";

/**
 * さくらのAI Engine 向けの互換フラグ（002 research R3）。
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

/** さくらを提供元として登録した Models。factory.toml の [models] の全モデルを持つ */
export function createSakuraModels(
  config: FactoryConfig,
  options: SakuraModelsOptions = {},
): Models {
  const compat = { ...DEFAULT_SAKURA_COMPAT, ...options.compat };
  const ids = [...new Set(Object.values(config.models).filter((id) => id !== undefined))];
  const models: Model<"openai-completions">[] = ids.map((id) => ({
    id,
    name: id,
    api: "openai-completions",
    provider: SAKURA_PROVIDER_ID,
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
      id: SAKURA_PROVIDER_ID,
      name: "さくらのAI Engine",
      baseUrl: config.llm.base_url,
      auth: { apiKey: envApiKeyAuth("さくらのAI Engine", [SAKURA_API_KEY_ENV]) },
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
  const model = models.getModel(SAKURA_PROVIDER_ID, id);
  if (model === undefined || model.api !== "openai-completions") {
    throw new Error(`モデル ${id}（[models].${role}）が さくら の提供元に登録されていません`);
  }
  return model as Model<"openai-completions">;
}
