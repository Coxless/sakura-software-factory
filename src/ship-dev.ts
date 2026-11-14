/**
 * pnpm run ship:dev: AI解禁の前に、出荷の工程（shipJob）だけを本物の GitHub で試す（008 contracts/ship-dev.md、research R10）。
 * テスト用のリポジトリを 007 の GitHub 層で取得し、パッチを当て、偽の「合格」の結果で shipJob を呼ぶ。
 * LLM は呼ばない。手動でだけ実行する。本物の GitHub に PR とコメントを作るので、テスト用のリポジトリにだけ使う。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execa } from "execa";
import {
  ConfigError,
  type FactoryConfig,
  loadConfig,
  WORK_TYPES,
  type WorkType,
} from "./config.ts";
import { createGitHubClient, readPrivateKey } from "./github/client.ts";
import { cloneForJob } from "./github/git.ts";
import type { GitHubPort } from "./github/port.ts";
import { createLogger } from "./log.ts";
import type { PipelineResult } from "./pipeline/run.ts";
import { shipJob } from "./pipeline/ship.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";
import { type Job, jobs } from "./queue/schema.ts";

export const EXIT_SHIPPED = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface ShipDevOptions {
  repo: string;
  issue: number;
  patch: string;
  workType: WorkType;
  summary: string;
  db?: string;
}

export class UsageError extends Error {}

export function parseShipDevArgs(argv: string[]): ShipDevOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args,
      options: {
        repo: { type: "string" },
        issue: { type: "string" },
        patch: { type: "string" },
        "work-type": { type: "string" },
        summary: { type: "string" },
        db: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const repo = values.repo;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new UsageError("--repo は owner/name の形で指定してください");
  }
  const issue = Number(values.issue);
  if (!Number.isInteger(issue) || issue < 1) {
    throw new UsageError("--issue は 1 以上の整数で指定してください");
  }
  const patch = values.patch;
  if (typeof patch !== "string" || !existsSync(patch)) {
    throw new UsageError("--patch には存在するパッチのファイルを指定してください");
  }
  const workType = (values["work-type"] ?? "docs") as string;
  if (!(WORK_TYPES as readonly string[]).includes(workType)) {
    throw new UsageError(`--work-type は ${WORK_TYPES.join(", ")} のどれかにしてください`);
  }
  const summary =
    typeof values.summary === "string" && values.summary.trim() !== ""
      ? values.summary
      : "ship:dev による出荷の確認";
  return {
    repo,
    issue,
    patch: resolve(patch),
    workType: workType as WorkType,
    summary,
    ...(typeof values.db === "string" && values.db !== "" ? { db: resolve(values.db) } : {}),
  };
}

export interface ShipDevIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  loadConfig?: () => FactoryConfig;
  /** テストでは偽物 */
  github?: GitHubPort;
  /** テストでは file:// の bare リポジトリ */
  cloneBaseUrl?: string;
  now?: () => number;
}

/** 偽の 005 の結果（合格）。LLM を呼ばないので requests は 0 */
export function fakePassedResult(
  options: Pick<ShipDevOptions, "summary" | "workType">,
): PipelineResult {
  return {
    outcome: "passed",
    plan: {
      summary: options.summary,
      steps: ["ship:dev で渡したパッチを当てる"],
      acceptance_criteria: ["ship:dev による出荷の確認"],
      work_type: options.workType,
    },
    planText: "",
    verdict: {
      verdict: "pass",
      reasons: "ship:dev による確認（LLM の判定は行っていません）",
      criteria: [{ criterion: "ship:dev による出荷の確認", met: true }],
    },
    reason: "ship:dev による確認",
    rounds: [],
    retries: 0,
    requests: 0,
    diff: "",
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    tracePath: "",
  };
}

export async function runShipDevCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: ShipDevIo,
): Promise<number> {
  let options: ShipDevOptions;
  let config: FactoryConfig;
  let github: GitHubPort;
  try {
    options = parseShipDevArgs(argv);
    config = (io.loadConfig ?? (() => loadConfig(env.FACTORY_CONFIG)))();
    if (io.github) {
      github = io.github;
    } else {
      const appId = env.GITHUB_APP_ID;
      const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
      if (!appId || !keyPath) {
        throw new UsageError("GITHUB_APP_ID と GITHUB_APP_PRIVATE_KEY_PATH を設定してください");
      }
      github = createGitHubClient({ appId, privateKey: readPrivateKey(keyPath) });
    }
  } catch (error) {
    io.stderr(
      `${error instanceof ConfigError || error instanceof UsageError ? error.message : String(error)}\n`,
    );
    return EXIT_USAGE;
  }

  const now = io.now ?? Date.now;
  const work = mkdtempSync(join(tmpdir(), "factory-ship-dev-"));
  const handle = openDatabase(options.db ?? join(work, "ship-dev.db"));
  const logger = createLogger({ level: "info" }, {
    write: (chunk: string) => io.stderr(chunk),
  } as unknown as Parameters<typeof createLogger>[1]);
  const secrets: string[] = [];
  try {
    runMigrations(handle.db);
    const started = now();
    const job = handle.db
      .insert(jobs)
      .values({
        repo: options.repo,
        issue_number: options.issue,
        trigger_comment_id: started,
        requested_by: "ship-dev",
        instruction: "ship:dev による出荷の確認",
        status: "judging",
        created_at: started,
        updated_at: started,
        started_at: started,
      })
      .returning()
      .get() as Job;
    const branch = `agent/issue-${options.issue}-job-${job.id}-ship-dev-${started}`;
    handle.db.update(jobs).set({ branch }).run();
    const workdir = join(work, "repo");
    const access = await github.getCloneAccess({ repo: options.repo });
    secrets.push(access.token);
    await cloneForJob({
      repo: options.repo,
      token: access.token,
      defaultBranch: access.defaultBranch,
      dir: workdir,
      branch,
      ...(io.cloneBaseUrl ? { baseUrl: io.cloneBaseUrl } : {}),
    });
    await execa("git", ["-C", workdir, "-c", "core.hooksPath=/dev/null", "apply", options.patch]);
    const issue = await github.getIssue({ repo: options.repo, issueNumber: options.issue });

    const outcome = await shipJob(
      {
        db: handle.db,
        config,
        logger,
        github,
        ...(io.cloneBaseUrl ? { cloneBaseUrl: io.cloneBaseUrl } : {}),
      },
      {
        job: { ...job, branch },
        workdir,
        branch,
        issue,
        result: fakePassedResult(options),
        interruption: () => undefined,
        secrets,
      },
    );
    if (outcome.kind === "shipped") {
      const row = handle.db.select().from(jobs).get();
      io.stdout(`PR: ${outcome.prUrl}\ndecision: ${outcome.decision}\nstatus: ${row?.status}\n`);
      return EXIT_SHIPPED;
    }
    const row = handle.db.select().from(jobs).get();
    io.stdout(`failed: ${outcome.failure}\nreason: ${row?.failure_reason ?? ""}\n`);
    return EXIT_FAILED;
  } catch (error) {
    let text = error instanceof Error ? error.message : String(error);
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    io.stderr(`実行に失敗しました: ${text}\n`);
    return EXIT_FAILED;
  } finally {
    handle.close();
    rmSync(join(work, "repo"), { recursive: true, force: true });
    if (!options.db) rmSync(work, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = await runShipDevCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
