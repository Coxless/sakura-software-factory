/**
 * pnpm run pipeline:dev: ローカルのリポジトリと Issue 文で、計画から判定までを1回通す（005 contracts/commands.md、research R12）。
 * 手動でだけ実行する。開発用の設定（Google AI Studio）で送るのは公開してよいリポジトリと Issue 文だけ（constitution 原則 I の例外の条件）。
 * 004 の implement:dev を置き換える（--plan を渡すと計画役を飛ばす）。
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
import { type DiffSource, gitDiffSource, listGitFiles } from "./pipeline/diff.ts";
import { type PipelineResult, runPipeline } from "./pipeline/run.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";
import { jobs } from "./queue/schema.ts";
import { createSandbox, installDependencies } from "./sandbox/docker.ts";
import { maskDeep } from "./trace/writer.ts";

export const EXIT_PASSED = 0;
export const EXIT_REJECTED = 1;
export const EXIT_ERROR = 2;
export const EXIT_FAILED = 3;

export interface PipelineDevOptions {
  repo: string;
  issue: string;
  instruction?: string;
  plan?: string;
  install?: string;
  maxTurns?: number;
  timeoutMinutes?: number;
  allowSakura: boolean;
  json: boolean;
}

/** 作業ディレクトリの用意（clone・依存のインストール・作業場）。テストでは差し替える */
export interface PreparedWorkdir {
  workspace: Workspace;
  /** clone した作業ディレクトリ（残す） */
  dir: string;
  /** 既定は git。テストでは偽物 */
  diff?: DiffSource;
  listFiles?: (workdir: string) => Promise<string[]>;
  /** git diff --stat */
  diffStat(): Promise<string>;
  /** 作業場を片付ける */
  close(): Promise<void>;
}

export interface PipelineDevIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  loadConfig?: () => FactoryConfig;
  createDeps?: (config: FactoryConfig, apiKey: string) => { deps: GateDeps; close(): void };
  prepare?: (
    options: PipelineDevOptions,
    config: FactoryConfig,
    jobId: number,
  ) => Promise<PreparedWorkdir>;
  now?: () => number;
  /** 中断（直接起動では SIGINT） */
  signal?: AbortSignal;
}

export class UsageError extends Error {}

export const PUBLIC_DATA_NOTICE =
  "開発用の LLM（Google AI Studio の無償枠）を使います。入出力は Google の学習と人のレビューに使われるため、公開してよいリポジトリと Issue 文だけを送ってください。\n";

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`${name} は 1 以上の整数で指定してください: ${value}`);
  }
  return parsed;
}

export function parsePipelineDevArgs(argv: string[]): PipelineDevOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        repo: { type: "string" },
        issue: { type: "string" },
        instruction: { type: "string" },
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
  for (const name of ["repo", "issue"]) {
    if (typeof values[name] !== "string" || values[name] === "") {
      throw new UsageError(`--${name} は必須です`);
    }
  }
  const maxTurns = positiveInteger(values["max-turns"] as string | undefined, "--max-turns");
  const timeoutMinutes = positiveInteger(
    values["timeout-minutes"] as string | undefined,
    "--timeout-minutes",
  );
  const optional = (name: string) =>
    typeof values[name] === "string" && values[name] !== "" ? (values[name] as string) : undefined;
  const instruction = optional("instruction");
  const plan = optional("plan");
  const install = optional("install");
  return {
    repo: values.repo as string,
    issue: values.issue as string,
    ...(instruction === undefined ? {} : { instruction }),
    ...(plan === undefined ? {} : { plan }),
    ...(install === undefined ? {} : { install }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    allowSakura: values["allow-sakura"] === true,
    json: values.json === true,
  };
}

/** Issue のファイル: 1行目をタイトル、残りを本文とする */
export function parseIssueFile(text: string): { title: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const newline = normalized.indexOf("\n");
  if (newline === -1) return { title: normalized.trim(), body: "" };
  return { title: normalized.slice(0, newline).trim(), body: normalized.slice(newline + 1).trim() };
}

/** 終わり方から終了コード */
export function exitCodeOf(result: Pick<PipelineResult, "outcome">): number {
  if (result.outcome === "passed") return EXIT_PASSED;
  if (result.outcome === "rejected") return EXIT_REJECTED;
  return EXIT_FAILED;
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

/** 元のリポジトリを一時ディレクトリに clone し、必要なら依存を入れて、作業場を用意する */
async function defaultPrepare(
  options: PipelineDevOptions,
  config: FactoryConfig,
  jobId: number,
): Promise<PreparedWorkdir> {
  const dir = join(mkdtempSync(join(tmpdir(), "factory-pipeline-dev-")), "repo");
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
    diff: gitDiffSource,
    listFiles: listGitFiles,
    diffStat: async () => {
      // 一時インデックスで、追跡していない新しいファイルも含めて数える（インデックスは変えない）
      const base = await gitDiffSource.base(dir);
      const { stat } = await gitDiffSource.diff(dir, base);
      return `${stat.files} files, +${stat.insertions} -${stat.deletions}`;
    },
    close: () => sandbox.destroy(),
  };
}

function formatResult(
  header: string,
  dir: string,
  result: PipelineResult,
  diffStat: string,
): string {
  const roundLines = result.rounds.map((r) =>
    [
      `${r.round}: implement=${r.implement.outcome}`,
      `checks=${r.checks.status}${r.checks.fedBack > 0 ? `(fed back ${r.checks.fedBack})` : ""}`,
      `verdict=${r.verdict}`,
      ...(r.reason ? [`reason=${r.reason}`] : []),
    ].join(" "),
  );
  return [
    header,
    `workdir: ${dir}`,
    `outcome: ${result.outcome}  rounds: ${result.rounds.length}  requests: ${result.requests}`,
    ...(result.plan
      ? [`plan: ${result.plan.summary}（work_type: ${result.plan.work_type}）`]
      : ["plan: （--plan で渡した計画）"]),
    ...(result.verdict ? [`verdict: ${result.verdict.verdict} — ${result.verdict.reasons}`] : []),
    `reason: ${result.reason}`,
    ...(result.error ? [`error: ${result.error}`] : []),
    `diff: ${result.diffStat.files} files, +${result.diffStat.insertions} -${result.diffStat.deletions}`,
    `trace: ${result.tracePath}`,
    "--- rounds ---",
    ...(roundLines.length > 0 ? roundLines : ["（なし）"]),
    "--- diff stat ---",
    diffStat || "（変更なし）",
    "",
  ].join("\n");
}

/** 計画から判定までを1回実行して終了コードを返す。0: passed、1: rejected、2: 実行前の失敗、3: それ以外の終わり方 */
export async function runPipelineDevCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: PipelineDevIo,
): Promise<number> {
  let options: PipelineDevOptions;
  try {
    options = parsePipelineDevArgs(argv);
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
  if (config.llm.provider === "google-ai-studio") io.stderr(PUBLIC_DATA_NOTICE);

  const apiKeyEnv = apiKeyEnvOf(config);
  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    io.stderr(`環境変数 ${apiKeyEnv} が設定されていません（LLM は呼んでいません）\n`);
    return EXIT_ERROR;
  }
  const mask = (text: string) => maskDeep(text, [apiKey]) as string;

  let issue: { title: string; body: string };
  let instruction: string | undefined;
  let plan: string | undefined;
  try {
    issue = parseIssueFile(readFileSync(options.issue, "utf8"));
    if (options.instruction) instruction = readFileSync(options.instruction, "utf8");
    if (options.plan) plan = readFileSync(options.plan, "utf8");
  } catch (error) {
    io.stderr(`Issue・依頼・計画のファイルを読めません: ${String(error)}\n`);
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

  let prepared: PreparedWorkdir | undefined;
  try {
    let jobId: number;
    try {
      const created = now();
      const [job] = handle.deps.db
        .insert(jobs)
        .values({
          repo: `local:${basename(resolve(options.repo))}`,
          issue_number: 0,
          trigger_comment_id: created,
          requested_by: "dev",
          instruction: instruction ?? "pipeline:dev",
          status: "planning",
          created_at: created,
          updated_at: created,
          started_at: created,
        })
        .returning()
        .all();
      jobId = job?.id as number;
      prepared = await (io.prepare ?? defaultPrepare)(options, config, jobId);
    } catch (error) {
      io.stderr(
        `準備に失敗しました: ${mask(error instanceof Error ? error.message : String(error))}\n`,
      );
      return EXIT_ERROR;
    }

    const timeoutMinutes = options.timeoutMinutes ?? config.limits.job_timeout_minutes;
    const gate: GateDeps =
      options.maxTurns === undefined
        ? handle.deps
        : {
            ...handle.deps,
            config: {
              ...config,
              limits: { ...config.limits, max_turns_per_phase: options.maxTurns },
            } as FactoryConfig,
          };
    const result = await runPipeline(
      {
        gate,
        now,
        ...(prepared.diff ? { diff: prepared.diff } : {}),
        ...(prepared.listFiles ? { listFiles: prepared.listFiles } : {}),
      },
      {
        jobId,
        workspace: prepared.workspace,
        workdir: prepared.dir,
        issue,
        ...(instruction === undefined ? {} : { instruction }),
        ...(plan === undefined ? {} : { plan }),
        deadline: now() + timeoutMinutes * 60_000,
        ...(io.signal ? { signal: io.signal } : {}),
        onPhase: (phase, round) => io.stderr(`[${phase}] round ${round}\n`),
      },
    );
    const diffStat = await prepared.diffStat().catch((error) => `（取得できません: ${error}）`);
    const header = `provider: ${providerOf(config).id}  planner: ${config.models.planner}  implementer: ${config.models.implementer}  verifier: ${config.models.verifier}  job: ${jobId}`;
    io.stdout(
      mask(
        options.json
          ? `${JSON.stringify(maskDeep({ jobId, workdir: prepared.dir, ...result, diffStat }, [apiKey]), null, 2)}\n`
          : formatResult(header, prepared.dir, result, diffStat),
      ),
    );
    return exitCodeOf(result);
  } catch (error) {
    io.stderr(
      `実行に失敗しました: ${mask(error instanceof Error ? error.message : String(error))}\n`,
    );
    return EXIT_FAILED;
  } finally {
    await prepared?.close().catch(() => {});
    handle.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("中断します（作業場を片付けてから終わります）\n");
    controller.abort();
  });
  process.exitCode = await runPipelineDevCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
  });
}
