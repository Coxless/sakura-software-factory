import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse, TomlError } from "smol-toml";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { LOG_LEVELS } from "./log.ts";

/** LLM の提供元。google-ai-studio は開発中だけ（constitution 原則 I の例外。常駐するファクトリーでは使わない） */
export const LLM_PROVIDER_IDS = ["sakura", "google-ai-studio"] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

const NonEmpty = Type.String({ minLength: 1 });
const Count = (minimum: number, defaultValue?: number) =>
  defaultValue === undefined
    ? Type.Integer({ minimum })
    : Type.Integer({ minimum, default: defaultValue });
const Range = (minimum: number, maximum: number, defaultValue: number) =>
  Type.Integer({ minimum, maximum, default: defaultValue });
const strict = { additionalProperties: false } as const;

/** 作業の種類（005 の計画役の出力・008 の自動マージ条件）。src/pipeline/plan.ts が re-export する */
export const WORK_TYPES = ["bugfix", "test", "docs", "refactor", "feature", "chore"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

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
    llm: Type.Object(
      {
        provider: Type.Enum([...LLM_PROVIDER_IDS], { default: "sakura" }),
        base_url: Type.String({ pattern: "^https://" }),
        /** 最初の1回を含む試行回数の上限 */
        max_attempts: Range(1, 10, 3),
        /** サーバーの待ち時間の指示がこれを超えたら再試行しない */
        max_retry_delay_seconds: Range(1, 600, 60),
        /** 1回の試行の時間の上限 */
        request_timeout_seconds: Range(10, 1800, 300),
      },
      strict,
    ),
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
            ".gitleaks.toml",
            ".gitleaksignore",
          ],
        }),
        allowed_work_types: Type.Array(NonEmpty, {
          minItems: 1,
          default: ["bugfix", "test", "docs", "refactor"],
        }),
        /** Issue にこのラベルがあれば Draft にする（008）。GitHub のラベルの名前の上限は 50 文字 */
        skip_label: Type.String({ minLength: 1, maxLength: 50, default: "no-auto-merge" }),
      },
      { ...strict, default: {} },
    ),
    github: Type.Object(
      {
        allowed_users: Type.Array(NonEmpty, { minItems: 1 }),
        /** Webhook の本文の上限（KB）。署名の検証の前に絞る（007） */
        webhook_max_body_kb: Range(64, 25600, 1024),
        /** 依頼の本文（@agent のあと）の上限。超えた分は切り詰める（007） */
        max_instruction_chars: Range(100, 200000, 20000),
      },
      strict,
    ),
    worker: Type.Object(
      {
        /** キューを見る間隔。受付が積んだときは待たずに取り出す（007） */
        poll_interval_seconds: Range(1, 300, 5),
        /** CI 待ちの見回りの間隔。CI の知らせを受けたときは待たずに見る（009） */
        ci_check_interval_seconds: Range(10, 3600, 60),
      },
      { ...strict, default: {} },
    ),
    storage: Type.Object(
      {
        database_path: Type.String({ minLength: 1, default: "data/factory.db" }),
        trace_dir: Type.String({ minLength: 1, default: "data/traces" }),
        /** ジョブごとの作業ディレクトリの置き場所（007）。作業場から bind mount できる場所にする */
        work_dir: Type.String({ minLength: 1, default: "data/work" }),
        /** 回帰評価の結果のファイルの置き場所（012） */
        eval_dir: Type.String({ minLength: 1, default: "data/evals" }),
      },
      { ...strict, default: {} },
    ),
    log: Type.Object(
      { level: Type.Enum([...LOG_LEVELS], { default: "info" }) },
      { ...strict, default: {} },
    ),
    http: Type.Object(
      {
        /** 待ち受けのアドレス。Caddy から転送するのでループバックが既定（006） */
        host: Type.String({ minLength: 1, default: "127.0.0.1" }),
        /** deploy/Caddyfile の転送先と合わせる */
        port: Range(1, 65535, 8787),
        /** 停止の合図のあと、処理中の要求を待つ上限 */
        shutdown_timeout_seconds: Range(1, 60, 10),
      },
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
    implementer: Type.Object(
      {
        /** 検査の拒否がこの回数続いたら工程を止める */
        max_consecutive_blocks: Range(1, 50, 5),
        /** 入力がコンテキストの上限のこの割合を超えたら古いツールの結果を縮める */
        compaction_ratio: Type.Number({ minimum: 0.3, maximum: 0.95, default: 0.7 }),
        /** 圧縮で残す直近のターン数 */
        keep_recent_turns: Range(1, 20, 4),
        max_agents_md_chars: Range(1000, 200000, 20000),
        max_issue_chars: Range(1000, 200000, 20000),
        max_plan_chars: Range(1000, 200000, 20000),
        max_feedback_chars: Range(1000, 200000, 30000),
      },
      { ...strict, default: {} },
    ),
    pipeline: Type.Object(
      {
        /** 工程内テストのコマンド（作業場で sh -c で順に実行）。空なら工程内テストを飛ばす */
        check_commands: Type.Array(NonEmpty, { default: ["pnpm run check"] }),
        check_timeout_seconds: Range(10, 3600, 600),
        /** 1回の実装工程で、テストの失敗を差し込む回数の上限 */
        max_check_feedbacks: Range(0, 10, 3),
        max_check_log_chars: Range(1000, 100000, 8000),
        max_diff_chars: Range(1000, 400000, 40000),
        max_file_list_chars: Range(1000, 100000, 10000),
        /** 依存のインストールのコマンド（ネットワークありの一時的な作業場で sh -c）。空なら飛ばす（007） */
        install_command: Type.String({ default: "pnpm install --frozen-lockfile" }),
        /** CI 失敗後のやり直しで実装役に渡す CI のログの合計の上限（009） */
        max_ci_log_chars: Range(1000, 100000, 12000),
      },
      { ...strict, default: {} },
    ),
    staging: Type.Object(
      {
        /** main への push をデプロイするリポジトリ（owner/name）。空ならデプロイしない（010） */
        repo: Type.String({ pattern: "^$|^[^/\\s]+/[^/\\s]+$", default: "" }),
        /** docker compose のプロジェクト名 */
        project: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$", default: "sakura-staging" }),
        /** イメージの名前（タグは commit の先頭 12 文字） */
        image_name: Type.String({
          pattern: "^[a-z0-9][a-z0-9._/-]*$",
          default: "sakura-staging-app",
        }),
        /** 127.0.0.1 に公開するポート（deploy/Caddyfile の転送先と合わせる） */
        port: Range(1024, 65535, 3100),
        health_path: Type.String({ pattern: "^/", default: "/healthz" }),
        health_timeout_seconds: Range(5, 600, 60),
        health_interval_seconds: Range(1, 60, 2),
        /** 続けて 200 が返る回数 */
        health_successes: Range(1, 20, 3),
        /** 取得とビルドの時間の上限 */
        build_timeout_seconds: Range(30, 3600, 600),
        /** 残しておく成功したイメージの数 */
        keep_images: Range(2, 50, 5),
        /** PR の本文に書くステージングの URL。空なら書かない */
        public_url: Type.String({ pattern: "^$|^https?://", default: "" }),
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
    case "maximum":
      return [{ path, message: `${String(params.limit)} 以下にしてください` }];
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

/** スキーマの誤りを「パス・日本語の理由」の一覧にする（005 の計画役・検査役の出力の検証でも使う） */
export function describeSchemaErrors(schema: TSchema, value: unknown): ConfigIssue[] {
  return [...Value.Errors(schema, value)].flatMap((error) =>
    translate(error as unknown as SchemaError),
  );
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
  const autoMerge = value.auto_merge as Record<string, unknown> | undefined;
  if (autoMerge && typeof autoMerge === "object" && Array.isArray(autoMerge.allowed_work_types)) {
    for (const [i, type] of autoMerge.allowed_work_types.entries()) {
      if (typeof type === "string" && !(WORK_TYPES as readonly string[]).includes(type)) {
        issues.push({
          path: `/auto_merge/allowed_work_types/${i}`,
          message: `作業の種類（${WORK_TYPES.join(", ")}）のどれかにしてください（現在 "${type}"）`,
        });
      }
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
  const issues = [...describeSchemaErrors(FactoryConfigSchema, value), ...crossCheck(value)];
  if (issues.length > 0) throw new ConfigError(source, issues);

  const config = value as Static<typeof FactoryConfigSchema>;
  config.storage.database_path = resolve(baseDir, config.storage.database_path);
  config.storage.trace_dir = resolve(baseDir, config.storage.trace_dir);
  config.storage.work_dir = resolve(baseDir, config.storage.work_dir);
  config.storage.eval_dir = resolve(baseDir, config.storage.eval_dir);
  return deepFreeze(config);
}

/** ループバックのアドレスか（127.0.0.0/8・::1・localhost）。外向きの待ち受けを警告するために使う */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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
