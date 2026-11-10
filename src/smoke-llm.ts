/**
 * pnpm run smoke:llm: さくらのAI Engine の実機スモークテスト（002 contracts/commands.md）。
 * 手動でだけ実行する（pnpm run check には含めない）。開発中は FACTORY_CONFIG=factory.dev.toml で Google AI Studio に向ける。呼び出しはすべて予算ゲートを通り、
 * llm_calls に job_id = NULL, phase = "smoke" で記録される。
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { OpenAICompletionsCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import Type from "typebox";
import Value from "typebox/value";
import { ConfigError, type FactoryConfig, loadConfig } from "./config.ts";
import { apiKeyEnvOf, createLlmModels } from "./llm/provider.ts";
import { runSmoke, SmokeError, type SmokeMode, type SmokeReport } from "./llm/smoke.ts";
import { type GateDeps, installStreamFnGuard } from "./llm/stream.ts";
import { createLogger } from "./log.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";

export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

const RoleSchema = Type.Union([
  Type.Literal("planner"),
  Type.Literal("implementer"),
  Type.Literal("verifier"),
  Type.Literal("verifier_alt"),
  Type.Literal("fallback"),
]);

const COMPAT_KEYS = new Set(
  Object.keys((OpenAICompletionsCompatSchema as { properties?: object }).properties ?? {}),
);

export interface SmokeCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** 既定は loadConfig()（FACTORY_CONFIG か ./factory.toml） */
  loadConfig?: () => FactoryConfig;
  /** テスト用: ゲートの依存を差し替える（偽の fetch と :memory: の DB）。既定は設定の DB と本物の fetch */
  createDeps?: (config: FactoryConfig, apiKey: string) => { deps: GateDeps; close(): void };
}

class UsageError extends Error {}

function parseCompatValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function parseCompat(pairs: string[]): Partial<OpenAICompletionsCompat> {
  const compat: Record<string, unknown> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) throw new UsageError(`--compat は key=value の形で指定してください: ${pair}`);
    const key = pair.slice(0, index);
    if (!COMPAT_KEYS.has(key)) {
      throw new UsageError(`--compat の未知の互換フラグです: ${key}`);
    }
    compat[key] = parseCompatValue(pair.slice(index + 1));
  }
  return compat as Partial<OpenAICompletionsCompat>;
}

interface CliOptions {
  role: "planner" | "implementer" | "verifier" | "verifier_alt" | "fallback";
  mode: SmokeMode;
  compat?: Partial<OpenAICompletionsCompat>;
  json: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values: ReturnType<typeof parse>["values"];
  function parse() {
    return parseArgs({
      args,
      options: {
        role: { type: "string", default: "implementer" },
        raw: { type: "boolean", default: false },
        "no-stream": { type: "boolean", default: false },
        compat: { type: "string", multiple: true, default: [] },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  }
  try {
    values = parse().values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (!Value.Check(RoleSchema, values.role)) {
    throw new UsageError(
      `--role は planner / implementer / verifier / verifier_alt / fallback のどれかです: ${values.role}`,
    );
  }
  if (values["no-stream"] && !values.raw) throw new UsageError("--no-stream は --raw と併用します");
  if (values.raw && values.compat.length > 0) {
    throw new UsageError("--compat は Pi 経由のときだけ使えます（--raw とは併用しない）");
  }
  const mode: SmokeMode = values.raw ? (values["no-stream"] ? "raw-nostream" : "raw") : "pi";
  return {
    role: values.role,
    mode,
    ...(values.compat.length > 0 ? { compat: parseCompat(values.compat) } : {}),
    json: values.json,
  };
}

function formatReport(report: SmokeReport): string {
  const header = [`provider: ${report.provider}`, `model: ${report.model}`, `mode: ${report.mode}`];
  if (report.compat) header.push(`compat: ${JSON.stringify(report.compat)}`);
  const lines = [header.join("  ")];
  for (const check of report.checks) {
    lines.push(`[${check.passed ? "PASS" : "FAIL"}] ${check.id} ${check.name}`);
    if (!check.passed && check.detail) {
      for (const detailLine of check.detail.split("\n")) lines.push(`       got: ${detailLine}`);
    }
  }
  lines.push(`requests: ${report.requests}`);
  return `${lines.join("\n")}\n`;
}

function defaultDeps(config: FactoryConfig, apiKey: string) {
  const handle = openDatabase(config.storage.database_path);
  runMigrations(handle.db);
  const deps: GateDeps = {
    db: handle.db,
    config,
    models: createLlmModels(config),
    logger: createLogger({ level: config.log.level }),
    apiKey,
  };
  return { deps, close: handle.close };
}

/** スモークテストを実行して終了コードを返す。0: 全部合格、1: 不合格あり、2: 実行前の失敗・呼び出しの失敗 */
export async function runSmokeCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: SmokeCliIo,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }

  let config: FactoryConfig;
  try {
    config = (io.loadConfig ?? (() => loadConfig(env.FACTORY_CONFIG)))();
  } catch (error) {
    io.stderr(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }

  // APIキーの環境変数は設定の提供元で決まる（さくら: SAKURA_AI_API_KEY、開発用の Google AI Studio: GEMINI_API_KEY）
  const apiKeyEnv = apiKeyEnvOf(config);
  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    io.stderr(`環境変数 ${apiKeyEnv} が設定されていません（LLM は呼んでいません）\n`);
    return EXIT_ERROR;
  }

  installStreamFnGuard();
  let handle: { deps: GateDeps; close(): void };
  try {
    handle = (io.createDeps ?? defaultDeps)(config, apiKey);
  } catch (error) {
    io.stderr(`データベースの準備に失敗しました: ${String(error)}\n`);
    return EXIT_ERROR;
  }

  try {
    const report = await runSmoke(handle.deps, {
      role: options.role,
      mode: options.mode,
      ...(options.compat ? { compat: options.compat } : {}),
    });
    io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.passed ? EXIT_PASSED : EXIT_FAILED;
  } catch (error) {
    if (error instanceof SmokeError) {
      io.stderr(`LLM 呼び出しに失敗しました: ${error.message}\nrequests: ${error.requests}\n`);
    } else {
      io.stderr(`スモークテストに失敗しました: ${String(error)}\n`);
    }
    return EXIT_ERROR;
  } finally {
    handle.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = await runSmokeCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
