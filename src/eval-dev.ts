/**
 * pnpm run eval:dev: 回帰評価（012 contracts/commands.md）。evals/ の各ケースを計画から判定まで回し、隠しチェックで採点して、
 * 結果のファイルを残し、直前の実行と比べる。--self-check は LLM を使わない自己確認。手動でだけ実行する。
 * 開発用の設定（Google AI Studio）で送るのは evals/ の公開データだけ（constitution 原則 I の例外の条件）。
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { execa } from "execa";
import { ConfigError, type FactoryConfig, loadConfig } from "./config.ts";
import { type EvalSet, EvalSetError, loadEvalSet } from "./evals/cases.ts";
import { compareRuns } from "./evals/compare.ts";
import { formatEstimate, formatRun, formatSelfCheck } from "./evals/format.ts";
import { type PrepareCase, prepareCase } from "./evals/prepare.ts";
import { EvalRunFileError, findBaseline, readEvalRun, writeEvalRun } from "./evals/result.ts";
import { defaultMaxRequests, type HarnessVersion, runEvals } from "./evals/runner.ts";
import { selfCheck } from "./evals/selfcheck.ts";
import { apiKeyEnvOf, createLlmModels } from "./llm/provider.ts";
import { type GateDeps, installStreamFnGuard } from "./llm/stream.ts";
import { createLogger } from "./log.ts";
import { PUBLIC_DATA_NOTICE, UsageError } from "./pipeline-dev.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";
import { maskDeep } from "./trace/writer.ts";

export const EXIT_OK = 0;
export const EXIT_SELF_CHECK_FAILED = 1;
export const EXIT_ERROR = 2;
export const EXIT_STOPPED = 3;

export interface EvalDevOptions {
  set: string;
  cases?: string[];
  repeat: number;
  maxRequests?: number;
  baseline?: string;
  timeoutMinutes?: number;
  allowSakura: boolean;
  selfCheck: boolean;
  json: boolean;
}

export interface EvalDevIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  loadConfig?: () => FactoryConfig;
  createDeps?: (config: FactoryConfig, apiKey: string) => { deps: GateDeps; close(): void };
  prepare?: PrepareCase;
  harness?: () => Promise<HarnessVersion>;
  now?: () => number;
  signal?: AbortSignal;
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`${name} は 1 以上の整数で指定してください: ${String(value)}`);
  }
  return parsed;
}

export function parseEvalDevArgs(argv: string[]): EvalDevOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        set: { type: "string" },
        cases: { type: "string" },
        repeat: { type: "string" },
        "max-requests": { type: "string" },
        baseline: { type: "string" },
        "timeout-minutes": { type: "string" },
        "allow-sakura": { type: "boolean", default: false },
        "self-check": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const cases =
    typeof values.cases === "string"
      ? values.cases
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : undefined;
  if (cases !== undefined && cases.length === 0) throw new UsageError("--cases が空です");
  const maxRequests = positiveInteger(values["max-requests"], "--max-requests");
  const timeoutMinutes = positiveInteger(values["timeout-minutes"], "--timeout-minutes");
  return {
    set: typeof values.set === "string" && values.set !== "" ? values.set : "evals",
    ...(cases ? { cases } : {}),
    repeat: positiveInteger(values.repeat, "--repeat") ?? 1,
    ...(maxRequests === undefined ? {} : { maxRequests }),
    ...(typeof values.baseline === "string" && values.baseline !== ""
      ? { baseline: values.baseline }
      : {}),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    allowSakura: values["allow-sakura"] === true,
    selfCheck: values["self-check"] === true,
    json: values.json === true,
  };
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

/** ハーネスの版: このファイルのリポジトリの HEAD と、作業ツリーの変更の有無 */
async function gitHarness(): Promise<HarnessVersion> {
  const cwd = import.meta.dirname;
  const head = await execa("git", ["rev-parse", "HEAD"], { cwd });
  const status = await execa("git", ["status", "--porcelain"], { cwd });
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
}

/** 評価を実行して終了コードを返す */
export async function runEvalDevCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: EvalDevIo,
): Promise<number> {
  let options: EvalDevOptions;
  try {
    options = parseEvalDevArgs(argv);
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

  let set: EvalSet;
  try {
    set = loadEvalSet(resolve(options.set), options.cases ? { only: options.cases } : {});
  } catch (error) {
    io.stderr(`${error instanceof EvalSetError ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
  const prepare = io.prepare ?? prepareCase;

  if (options.selfCheck) {
    const results = await selfCheck(set, config, prepare, {
      ...(io.now ? { now: io.now } : {}),
      ...(io.signal ? { signal: io.signal } : {}),
      onCase: (c) => io.stderr(`[self-check] ${c.id}\n`),
    });
    io.stdout(options.json ? `${JSON.stringify(results, null, 2)}\n` : formatSelfCheck(results));
    return results.every((r) => r.ok) && results.length === set.cases.length
      ? EXIT_OK
      : EXIT_SELF_CHECK_FAILED;
  }

  // 開始前の検査（LLM を呼ばない）
  for (const role of ["verifier", "verifier_alt"] as const) {
    if (config.models[role] !== undefined && config.models[role] === config.models.implementer) {
      io.stderr(
        `[models].${role} と [models].implementer が同じモデル（${config.models.implementer}）です。実装と検査は別系統のモデルにしてください（原則 III）\n`,
      );
      return EXIT_ERROR;
    }
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

  const maxRequests =
    options.maxRequests ?? defaultMaxRequests(set.cases.length, options.repeat, config);
  io.stderr(
    formatEstimate({
      cases: set.cases.length,
      repeat: options.repeat,
      maxRequests,
      perJob: config.budget.per_job_requests,
      altVerifier: config.models.verifier_alt !== undefined,
    }),
  );

  installStreamFnGuard();
  let handle: { deps: GateDeps; close(): void };
  try {
    handle = (io.createDeps ?? defaultDeps)(config, apiKey);
  } catch (error) {
    io.stderr(`データベースの準備に失敗しました: ${mask(String(error))}\n`);
    return EXIT_ERROR;
  }
  try {
    const run = await runEvals(
      {
        gate: handle.deps,
        prepare,
        ...(io.now ? { now: io.now } : {}),
        harness: io.harness ?? gitHarness,
      },
      {
        set,
        repeat: options.repeat,
        maxRequests,
        timeoutMinutes: options.timeoutMinutes ?? config.limits.job_timeout_minutes,
        cases: options.cases ?? null,
        ...(io.signal ? { signal: io.signal } : {}),
        onProgress: (event) => {
          if (event.type === "case_start") {
            io.stderr(`[${event.index}/${event.total}] ${event.caseId}#${event.attempt}\n`);
          } else if (event.type === "phase") {
            io.stderr(`  [${event.phase}] round ${event.round}\n`);
          } else if (event.type === "grading") {
            io.stderr("  [grading]\n");
          } else if (event.type === "judging_alt") {
            io.stderr("  [judging_alt]\n");
          } else if (event.type === "case_end") {
            io.stderr(`  → ${event.result.status}（requests ${event.result.requests}）\n`);
          } else if (event.type === "stopped") {
            io.stderr(`評価を止めました: ${event.reason}\n`);
          }
        },
      },
    );
    const resultPath = writeEvalRun(config.storage.eval_dir, run);

    let comparison: ReturnType<typeof compareRuns> | undefined;
    if (options.baseline) {
      try {
        comparison = compareRuns(readEvalRun(options.baseline), run);
      } catch (error) {
        io.stderr(
          `比較の相手を読めません: ${error instanceof EvalRunFileError ? error.message : String(error)}\n`,
        );
      }
    } else {
      const { found, warnings } = findBaseline(config.storage.eval_dir, run.setName, run.startedAt);
      for (const warning of warnings) io.stderr(`警告: ${warning}\n`);
      if (found) comparison = compareRuns(found.run, run);
    }

    io.stdout(
      mask(
        options.json
          ? `${JSON.stringify({ resultPath, ...run, ...(comparison ? { comparison } : {}) }, null, 2)}\n`
          : formatRun(run, { resultPath, ...(comparison ? { comparison } : {}) }),
      ),
    );
    return run.stopped ? EXIT_STOPPED : EXIT_OK;
  } catch (error) {
    io.stderr(
      `評価に失敗しました: ${mask(error instanceof Error ? error.message : String(error))}\n`,
    );
    return EXIT_STOPPED;
  } finally {
    handle.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write(
      "中断します（実行中のケースの作業場を片付け、結果を残してから終わります）\n",
    );
    controller.abort();
  });
  process.exitCode = await runEvalDevCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    signal: controller.signal,
  });
}
