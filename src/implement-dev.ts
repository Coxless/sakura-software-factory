/**
 * pnpm run implement:dev: 開発用の LLM（Google AI Studio の無償枠）で、ローカルのリポジトリの複製に対して
 * 実装工程を1回実行する（004 contracts/commands.md、research R10）。手動でだけ実行する。
 * 送るのは公開してよいリポジトリと Issue 文だけ（constitution 原則 I の例外の条件）。
 * 005 の CLI ができたら置き換えるか統合する。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execa } from "execa";
import { ConfigError, type FactoryConfig, loadConfig } from "./config.ts";
import { type Workspace, workspaceFromSandbox } from "./harness/workspace.ts";
import { apiKeyEnvOf, createLlmModels, providerOf } from "./llm/provider.ts";
import { type GateDeps, installStreamFnGuard } from "./llm/stream.ts";
import { createLogger } from "./log.ts";
import { type ImplementerResult, runImplementer } from "./pipeline/implement.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";
import { jobs } from "./queue/schema.ts";
import { createSandbox, installDependencies } from "./sandbox/docker.ts";

export const EXIT_COMPLETED = 0;
export const EXIT_NOT_COMPLETED = 1;
export const EXIT_ERROR = 2;

export interface ImplementDevOptions {
  repo: string;
  issue: string;
  plan: string;
  install?: string;
  maxTurns?: number;
  timeoutMinutes?: number;
  allowSakura: boolean;
  json: boolean;
}

/** 作業ディレクトリの用意（clone・作業場・依存のインストール）。テストでは差し替える */
export interface PreparedWorkspace {
  workspace: Workspace;
  /** clone した作業ディレクトリ（残す） */
  dir: string;
  /** git diff --stat */
  diffStat(): Promise<string>;
  /** 作業場を片付ける */
  close(): Promise<void>;
}

export interface ImplementDevIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  loadConfig?: () => FactoryConfig;
  createDeps?: (config: FactoryConfig, apiKey: string) => { deps: GateDeps; close(): void };
  prepare?: (
    options: ImplementDevOptions,
    config: FactoryConfig,
    jobId: number,
  ) => Promise<PreparedWorkspace>;
  now?: () => number;
}

export class UsageError extends Error {}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`${name} は 1 以上の整数で指定してください: ${value}`);
  }
  return parsed;
}

export function parseImplementDevArgs(argv: string[]): ImplementDevOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        repo: { type: "string" },
        issue: { type: "string" },
        plan: { type: "string" },
        install: { type: "string" },
        "max-turns": { type: "string" },
        "timeout-minutes": { type: "string" },
        "allow-sakura": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  for (const name of ["repo", "issue", "plan"]) {
    if (typeof values[name] !== "string" || values[name] === "") {
      throw new UsageError(`--${name} は必須です`);
    }
  }
  const maxTurns = positiveInteger(values["max-turns"] as string | undefined, "--max-turns");
  const timeoutMinutes = positiveInteger(
    values["timeout-minutes"] as string | undefined,
    "--timeout-minutes",
  );
  return {
    repo: values.repo as string,
    issue: values.issue as string,
    plan: values.plan as string,
    ...(typeof values.install === "string" ? { install: values.install } : {}),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    allowSakura: values["allow-sakura"] === true,
    json: values.json === true,
  };
}

/** 終わり方から終了コード */
export function exitCodeOf(result: Pick<ImplementerResult, "outcome">): number {
  return result.outcome === "completed" ? EXIT_COMPLETED : EXIT_NOT_COMPLETED;
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

/** 元のリポジトリを一時ディレクトリに clone し、作業場を用意して、必要なら依存を入れる */
async function defaultPrepare(
  options: ImplementDevOptions,
  config: FactoryConfig,
  jobId: number,
): Promise<PreparedWorkspace> {
  const dir = join(mkdtempSync(join(tmpdir(), "factory-implement-dev-")), "repo");
  await execa("git", ["clone", "--quiet", "--local", "--no-hardlinks", resolve(options.repo), dir]);
  if (options.install) {
    const installed = await installDependencies({
      jobId,
      workspace: dir,
      sandbox: config.sandbox,
      command: ["sh", "-c", options.install],
    });
    if (installed.exitCode !== 0) {
      throw new Error(
        `依存のインストールに失敗しました（終了コード ${installed.exitCode}）:\n${new TextDecoder().decode(installed.stderr).slice(-2000)}`,
      );
    }
  }
  const sandbox = await createSandbox({ jobId, workspace: dir, sandbox: config.sandbox });
  return {
    workspace: workspaceFromSandbox(sandbox, config),
    dir,
    diffStat: async () => (await execa("git", ["-C", dir, "diff", "--stat"])).stdout,
    close: () => sandbox.destroy(),
  };
}

function formatResult(
  header: string,
  dir: string,
  result: ImplementerResult,
  diffStat: string,
): string {
  return [
    header,
    `workspace: ${dir}`,
    `outcome: ${result.outcome}  turns: ${result.turns}  requests: ${result.requests}  tool calls: ${result.toolCalls}  blocked: ${result.blockedCalls}`,
    ...(result.error ? [`error: ${result.error}`] : []),
    `trace: ${result.tracePath}`,
    "--- last message ---",
    result.lastMessage,
    "--- git diff --stat ---",
    diffStat || "（変更なし）",
    "",
  ].join("\n");
}

/** 実装工程を1回実行して終了コードを返す。0: completed、1: それ以外の終わり方、2: 実行前の失敗 */
export async function runImplementDevCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: ImplementDevIo,
): Promise<number> {
  let options: ImplementDevOptions;
  try {
    options = parseImplementDevArgs(argv);
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

  if (config.llm.provider === "sakura" && !options.allowSakura) {
    io.stderr(
      '[llm].provider = "sakura" です。AI解禁の前に さくらの枠を使わないよう、--allow-sakura がなければ実行しません（開発中は FACTORY_CONFIG=factory.dev.toml）\n',
    );
    return EXIT_ERROR;
  }

  const apiKeyEnv = apiKeyEnvOf(config);
  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    io.stderr(`環境変数 ${apiKeyEnv} が設定されていません（LLM は呼んでいません）\n`);
    return EXIT_ERROR;
  }

  let issue: string;
  let plan: string;
  try {
    issue = readFileSync(options.issue, "utf8");
    plan = readFileSync(options.plan, "utf8");
  } catch (error) {
    io.stderr(`Issue・計画のファイルを読めません: ${String(error)}\n`);
    return EXIT_ERROR;
  }

  installStreamFnGuard();
  const now = io.now ?? Date.now;
  let handle: { deps: GateDeps; close(): void };
  try {
    handle = (io.createDeps ?? defaultDeps)(config, apiKey);
  } catch (error) {
    io.stderr(`データベースの準備に失敗しました: ${String(error)}\n`);
    return EXIT_ERROR;
  }

  let prepared: PreparedWorkspace | undefined;
  try {
    const created = now();
    const [job] = handle.deps.db
      .insert(jobs)
      .values({
        repo: `local:${basename(resolve(options.repo))}`,
        issue_number: 0,
        trigger_comment_id: created,
        requested_by: "dev",
        instruction: "implement:dev",
        status: "implementing",
        created_at: created,
        updated_at: created,
        started_at: created,
      })
      .returning()
      .all();
    const jobId = job?.id as number;
    prepared = await (io.prepare ?? defaultPrepare)(options, config, jobId);
    const timeoutMinutes = options.timeoutMinutes ?? config.limits.job_timeout_minutes;
    const result = await runImplementer(
      { gate: handle.deps, now },
      {
        jobId,
        workspace: prepared.workspace,
        issue,
        plan,
        deadline: now() + timeoutMinutes * 60_000,
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      },
    );
    const diffStat = await prepared.diffStat().catch((error) => `（取得できません: ${error}）`);
    const header = `provider: ${providerOf(config).id}  model: ${config.models.implementer}  job: ${jobId}`;
    io.stdout(
      options.json
        ? `${JSON.stringify({ jobId, workspace: prepared.dir, ...result, diffStat }, null, 2)}\n`
        : formatResult(header, prepared.dir, result, diffStat),
    );
    return exitCodeOf(result);
  } catch (error) {
    io.stderr(`実行に失敗しました: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  } finally {
    await prepared?.close().catch(() => {});
    handle.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = await runImplementDevCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
