import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import {
  apiKeyEnvOf,
  assertProductionProvider,
  createLlmModels,
  DEFAULT_SAKURA_COMPAT,
  GOOGLE_AI_STUDIO_API_KEY_ENV,
  modelForRole,
  providerOf,
  SAKURA_API_KEY_ENV,
  SAKURA_PROVIDER_ID,
} from "./provider.ts";

const toml = (extraModels = "") => `
[llm]
base_url = "https://example.test/v1"

[models]
planner = "plan-model"
implementer = "impl-model"
verifier = "verify-model"
fallback = "fallback-model"
${extraModels}

[budget]
monthly_requests = 3000
per_job_requests = 100

[github]
allowed_users = ["u"]
`;

describe("createLlmModels（さくら）", () => {
  test("[models] の全モデルを さくら の提供元で持つ（重複は1つにまとめる）", () => {
    const config = parseConfig(toml(), "/tmp");
    const models = createLlmModels(config);
    const ids = models
      .getModels(SAKURA_PROVIDER_ID)
      .map((model) => model.id)
      .sort();
    expect(ids).toEqual(["fallback-model", "impl-model", "plan-model", "verify-model"]);
  });

  test("verifier_alt は設定があるときだけ持つ", () => {
    const config = parseConfig(toml('verifier_alt = "alt-model"'), "/tmp");
    const ids = createLlmModels(config)
      .getModels(SAKURA_PROVIDER_ID)
      .map((model) => model.id);
    expect(ids).toContain("alt-model");
  });

  test("各モデルは base_url・openai-completions・既定の互換フラグを持つ", () => {
    const config = parseConfig(toml(), "/tmp");
    const model = createLlmModels(config).getModel(SAKURA_PROVIDER_ID, "impl-model");
    expect(model).toMatchObject({
      provider: SAKURA_PROVIDER_ID,
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      compat: DEFAULT_SAKURA_COMPAT,
    });
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("互換フラグは一部だけ上書きできる", () => {
    const config = parseConfig(toml(), "/tmp");
    const model = createLlmModels(config, {
      compat: { supportsUsageInStreaming: false },
    }).getModel(SAKURA_PROVIDER_ID, "impl-model");
    expect(model?.compat).toEqual({ ...DEFAULT_SAKURA_COMPAT, supportsUsageInStreaming: false });
  });

  test("APIキーの環境変数名は SAKURA_AI_API_KEY", () => {
    expect(SAKURA_API_KEY_ENV).toBe("SAKURA_AI_API_KEY");
  });
});

describe("modelForRole", () => {
  test("役割の設定のモデル名のモデルを返す", () => {
    const config = parseConfig(toml(), "/tmp");
    const models = createLlmModels(config);
    expect(modelForRole(models, config, "implementer").id).toBe("impl-model");
    expect(modelForRole(models, config, "verifier").id).toBe("verify-model");
    expect(modelForRole(models, config, "fallback").id).toBe("fallback-model");
  });

  test("設定にない verifier_alt は例外（退避先へは切り替えない）", () => {
    const config = parseConfig(toml(), "/tmp");
    const models = createLlmModels(config);
    expect(() => modelForRole(models, config, "verifier_alt")).toThrow(/verifier_alt/);
  });

  test("登録されていないモデル名は例外（退避先へは切り替えない）", () => {
    const config = parseConfig(toml(), "/tmp");
    const other = createLlmModels(parseConfig(toml().replace("impl-model", "x"), "/tmp"));
    expect(() => modelForRole(other, config, "implementer")).toThrow(/impl-model/);
  });
});

describe("開発用の提供元（Google AI Studio）", () => {
  const devToml = () =>
    toml().replace(
      'base_url = "https://example.test/v1"',
      'provider = "google-ai-studio"\nbase_url = "https://generativelanguage.googleapis.com/v1beta/openai"',
    );

  test("provider を省くと さくら（環境変数 SAKURA_AI_API_KEY）", () => {
    const config = parseConfig(toml(), "/tmp");
    expect(providerOf(config)).toMatchObject({ id: "sakura", apiKeyEnv: SAKURA_API_KEY_ENV });
    expect(apiKeyEnvOf(config)).toBe("SAKURA_AI_API_KEY");
  });

  test("google-ai-studio なら、その提供元で全モデルを持ち、APIキーは GEMINI_API_KEY", () => {
    const config = parseConfig(devToml(), "/tmp");
    expect(GOOGLE_AI_STUDIO_API_KEY_ENV).toBe("GEMINI_API_KEY");
    expect(apiKeyEnvOf(config)).toBe("GEMINI_API_KEY");
    const models = createLlmModels(config);
    expect(models.getModels(SAKURA_PROVIDER_ID)).toEqual([]);
    const model = modelForRole(models, config, "implementer");
    expect(model).toMatchObject({
      id: "impl-model",
      provider: "google-ai-studio",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      api: "openai-completions",
    });
  });

  test("常駐するファクトリーは さくら以外では起動しない（原則 I）", () => {
    expect(() => assertProductionProvider(parseConfig(toml(), "/tmp"))).not.toThrow();
    expect(() => assertProductionProvider(parseConfig(devToml(), "/tmp"))).toThrow(
      /google-ai-studio/,
    );
  });
});
