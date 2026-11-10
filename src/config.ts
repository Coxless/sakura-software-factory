import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse, TomlError } from "smol-toml";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { LOG_LEVELS } from "./log.ts";

const NonEmpty = Type.String({ minLength: 1 });
const Count = (minimum: number, defaultValue?: number) =>
  defaultValue === undefined
    ? Type.Integer({ minimum })
    : Type.Integer({ minimum, default: defaultValue });
const strict = { additionalProperties: false } as const;

/** ツールで書き込みを拒否するパス（層3）。auto_merge.forbidden_paths（層6）とは別の一覧 */
export const DEFAULT_DENY_WRITE_PATHS = [
  ".git",
  ".git/**",
  "**/.git/**",
  ".github/workflows/**",
  ".env*",
  "**/.env*",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "deploy/**",
] as const;

export const FactoryConfigSchema = Type.Object(
  {
    llm: Type.Object({ base_url: Type.String({ pattern: "^https://" }) }, strict),
    models: Type.Object(
      {
        planner: NonEmpty,
        implementer: NonEmpty,
        verifier: NonEmpty,
        verifier_alt: Type.Optional(NonEmpty),
        fallback: NonEmpty,
      },
      strict,
    ),
    budget: Type.Object(
      {
        monthly_requests: Count(1),
        per_job_requests: Count(1),
        timezone: Type.String({ minLength: 1, default: "Asia/Tokyo" }),
      },
      strict,
    ),
    limits: Type.Object(
      {
        judge_retries: Count(0, 2),
        ci_retries: Count(0, 2),
        max_turns_per_phase: Count(1, 40),
        job_timeout_minutes: Count(1, 60),
        ci_wait_timeout_minutes: Count(1, 30),
      },
      { ...strict, default: {} },
    ),
    auto_merge: Type.Object(
      {
        max_diff_lines: Count(1, 300),
        forbidden_paths: Type.Array(NonEmpty, {
          default: [
            ".github/workflows/**",
            ".env*",
            "**/pnpm-lock.yaml",
            "**/package-lock.json",
            "**/yarn.lock",
            "deploy/**",
          ],
        }),
        allowed_work_types: Type.Array(NonEmpty, {
          minItems: 1,
          default: ["bugfix", "test", "docs", "refactor"],
        }),
      },
      { ...strict, default: {} },
    ),
    github: Type.Object({ allowed_users: Type.Array(NonEmpty, { minItems: 1 }) }, strict),
    storage: Type.Object(
      {
        database_path: Type.String({ minLength: 1, default: "data/factory.db" }),
        trace_dir: Type.String({ minLength: 1, default: "data/traces" }),
      },
      { ...strict, default: {} },
    ),
    log: Type.Object(
      { level: Type.Enum([...LOG_LEVELS], { default: "info" }) },
      { ...strict, default: {} },
    ),
    sandbox: Type.Object(
      {
        image: Type.String({ minLength: 1, default: "factory-sandbox:latest" }),
        user: Type.Optional(Type.String({ pattern: "^[0-9]+:[0-9]+$" })),
        cpus: Type.Number({ exclusiveMinimum: 0, default: 2 }),
        memory_mb: Count(128, 2048),
        pids_limit: Count(16, 512),
        tmp_size_mb: Count(16, 512),
        install_timeout_seconds: Count(1, 600),
      },
      { ...strict, default: {} },
    ),
    tools: Type.Object(
      {
        bash_timeout_seconds: Count(1, 120),
        bash_max_timeout_seconds: Count(1, 600),
        read_max_lines: Count(1, 2000),
        max_output_chars: Count(1000, 20000),
        deny_write_paths: Type.Array(NonEmpty, { default: [...DEFAULT_DENY_WRITE_PATHS] }),
      },
      { ...strict, default: {} },
    ),
  },
  strict,
);

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type FactoryConfig = DeepReadonly<Static<typeof FactoryConfigSchema>>;

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(source: string, issues: ConfigIssue[], action = "検証") {
    const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
    super(`${source} の${action}に失敗しました（${issues.length}件）\n${lines.join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const SECRET_LIKE = /key|token|secret|password/i;

interface SchemaError {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
  message: string;
}

function translate(error: SchemaError): ConfigIssue[] {
  const { keyword, instancePath: path, params } = error;
  switch (keyword) {
    case "boolean":
      // additionalProperties: false の重複報告。additionalProperties 側で扱う
      return [];
    case "required":
      return (params.requiredProperties as string[]).map((name) => ({
        path: `${path}/${name}`,
        message: "必須の項目がありません",
      }));
    case "additionalProperties":
      return (params.additionalProperties as string[]).map((name) => ({
        path: `${path}/${name}`,
        message: SECRET_LIKE.test(name)
          ? "未知の項目です。秘密情報は設定ファイルに書かず、環境変数で渡してください"
          : "未知の項目です（綴りを確かめてください）",
      }));
    case "type":
      return [{ path, message: `${String(params.type)} 型にしてください` }];
    case "minimum":
      return [{ path, message: `${String(params.limit)} 以上にしてください` }];
    case "exclusiveMinimum":
      return [{ path, message: `${String(params.limit)} より大きくしてください` }];
    case "minLength":
      return [{ path, message: `${String(params.limit)} 文字以上にしてください` }];
    case "minItems":
      return [{ path, message: `${String(params.limit)} 件以上にしてください` }];
    case "enum":
      return [
        {
          path,
          message: `次のどれかにしてください: ${(params.allowedValues as unknown[]).join(", ")}`,
        },
      ];
    case "pattern":
      return [
        { path, message: `形式が違います（${String(params.pattern)} に合うようにしてください）` },
      ];
    default:
      return [{ path, message: error.message }];
  }
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** スキーマで表せない検証。型が合っている項目だけを見る（型の誤りはスキーマ側で報告済み） */
function crossCheck(value: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const budget = value.budget as Record<string, unknown> | undefined;
  if (budget && typeof budget === "object") {
    const { monthly_requests: monthly, per_job_requests: perJob, timezone } = budget;
    if (
      Number.isInteger(monthly) &&
      Number.isInteger(perJob) &&
      (perJob as number) > (monthly as number)
    ) {
      issues.push({
        path: "/budget/per_job_requests",
        message: `monthly_requests（${monthly}）以下にしてください（現在 ${perJob}）`,
      });
    }
    if (typeof timezone === "string" && timezone.length > 0 && !isValidTimeZone(timezone)) {
      issues.push({
        path: "/budget/timezone",
        message: `IANA のタイムゾーン名ではありません: ${timezone}`,
      });
    }
  }
  const sandbox = value.sandbox as Record<string, unknown> | undefined;
  if (sandbox && typeof sandbox === "object" && typeof sandbox.user === "string") {
    if (/^0+:/.test(sandbox.user)) {
      issues.push({
        path: "/sandbox/user",
        message: `<uid>:<gid> の形で、uid は 0 以外にしてください（現在 "${sandbox.user}"）`,
      });
    }
  }
  const tools = value.tools as Record<string, unknown> | undefined;
  if (tools && typeof tools === "object") {
    const { bash_timeout_seconds: timeout, bash_max_timeout_seconds: max } = tools;
    if (
      Number.isInteger(timeout) &&
      Number.isInteger(max) &&
      (timeout as number) > (max as number)
    ) {
      issues.push({
        path: "/tools/bash_timeout_seconds",
        message: `bash_max_timeout_seconds（${max}）以下にしてください（現在 ${timeout}）`,
      });
    }
  }
  return issues;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** TOML の文字列を検証して、型付きで凍結した設定を返す。`baseDir` は保存先の相対パスの基準 */
export function parseConfig(
  tomlText: string,
  baseDir: string,
  source = "factory.toml",
): FactoryConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parse(tomlText) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(source, [
        {
          path: "/",
          message: `TOML の構文エラー（${error.line}行 ${error.column}列）: ${error.message}`,
        },
      ]);
    }
    throw error;
  }

  const value = Value.Default(FactoryConfigSchema, raw) as Record<string, unknown>;
  const issues = [
    ...[...Value.Errors(FactoryConfigSchema, value)].flatMap((error) =>
      translate(error as unknown as SchemaError),
    ),
    ...crossCheck(value),
  ];
  if (issues.length > 0) throw new ConfigError(source, issues);

  const config = value as Static<typeof FactoryConfigSchema>;
  config.storage.database_path = resolve(baseDir, config.storage.database_path);
  config.storage.trace_dir = resolve(baseDir, config.storage.trace_dir);
  return deepFreeze(config);
}

/** 設定ファイルを読む。既定は環境変数 FACTORY_CONFIG、なければ ./factory.toml */
export function loadConfig(path = process.env.FACTORY_CONFIG ?? "./factory.toml"): FactoryConfig {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new ConfigError(
      absolute,
      [{ path: "/", message: `設定ファイルがありません: ${absolute}` }],
      "読み込み",
    );
  }
  return parseConfig(readFileSync(absolute, "utf8"), dirname(absolute), absolute);
}

/** 秘密情報を環境変数から読む。なければ名前を含むエラー */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}
