import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";
import { type FactoryConfig, parseConfig } from "../config.ts";
import { createBareRepo, FakeGitHub, type FakeGitHubOptions } from "../github/testing.ts";
import { createLogger } from "../log.ts";
import { enqueueJob } from "../queue/jobs.ts";
import { type Job, jobEvents, jobs } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import type { PipelineInput, PipelineResult } from "./run.ts";
import {
  classifyOutcome,
  createWorker,
  type PipelinePort,
  recoverOnStartup,
  type Worker,
  type WorkerDeps,
} from "./worker.ts";

const TOKEN = "ghs_FakeInstallationToken0123456789abcd";

function config(workDir: string, extra = ""): FactoryConfig {
  return parseConfig(
    `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"
[models]
planner = "p"
implementer = "i"
verifier = "v"
fallback = "f"
[budget]
monthly_requests = 1000
per_job_requests = 10
[github]
allowed_users = ["octo-requester"]
[worker]
poll_interval_seconds = 300
[storage]
work_dir = "${workDir}"
${extra}
`,
    "/srv/factory",
  );
}

function result(
  outcome: PipelineResult["outcome"],
  extra: Partial<PipelineResult> = {},
): PipelineResult {
  return {
    outcome,
    planText: "",
    reason: "最後の理由",
    rounds: [],
    retries: 1,
    requests: 0,
    diff: "",
    diffStat: { files: 2, insertions: 5, deletions: 1 },
    tracePath: "/tmp/trace.jsonl",
    ...extra,
  };
}

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

interface SetupOptions {
  pipeline?: PipelinePort;
  github?: FakeGitHubOptions;
  install?: WorkerDeps["install"];
  configExtra?: string;
  jobTimeoutMs?: number;
  stopTimeoutMs?: number;
}

async function setup(options: SetupOptions = {}) {
  const { baseUrl } = await createBareRepo();
  const workDir = mkdtempSync(join(tmpdir(), "factory-work-"));
  const handle = migratedMemoryDb();
  const lines: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  );
  const github = new FakeGitHub({ token: TOKEN, ...options.github });
  const installs: { jobId: number; workdir: string; gitConfig: string }[] = [];
  const removed: (number | undefined)[] = [];
  const pipelineInputs: Omit<PipelineInput, "workspace">[] = [];
  const pipelineConfigs: string[] = [];
  const deps: WorkerDeps = {
    db: handle.db,
    config: config(workDir, options.configExtra),
    logger,
    github,
    cloneBaseUrl: baseUrl,
    install:
      options.install ??
      (async (jobId, workdir) => {
        installs.push({
          jobId,
          workdir,
          gitConfig: readFileSync(join(workdir, ".git", "config"), "utf8"),
        });
        return { exitCode: 0, stderrTail: "" };
      }),
    removeSandboxes: async (jobId) => {
      removed.push(jobId);
    },
    pipeline: async (input) => {
      pipelineInputs.push(input);
      pipelineConfigs.push(readFileSync(join(input.workdir, ".git", "config"), "utf8"));
      return (options.pipeline ?? (async () => result("passed", { verdict: verdict() })))(input);
    },
    ...(options.jobTimeoutMs === undefined ? {} : { jobTimeoutMs: options.jobTimeoutMs }),
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
  };
  const enqueue = (commentId: number, at = Date.now()) =>
    enqueueJob(
      handle.db,
      {
        repo: "octo-org/demo",
        issue_number: 7,
        trigger_comment_id: commentId,
        requested_by: "octo-requester",
        instruction: `依頼 ${commentId}`,
      },
      at,
    ).job;
  const start = () => {
    const worker = createWorker(deps);
    workers.push(worker);
    worker.start();
    return worker;
  };
  const jobOf = (id: number) => handle.db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
  const eventsOf = (id: number) =>
    handle.db.select().from(jobEvents).where(eq(jobEvents.job_id, id)).all();
  return {
    ...handle,
    deps,
    github,
    installs,
    removed,
    pipelineInputs,
    pipelineConfigs,
    workDir,
    enqueue,
    start,
    jobOf,
    eventsOf,
    logs: () => lines.join(""),
  };
}

const verdict = () => ({
  verdict: "pass" as const,
  reasons: "受け入れ条件をすべて満たす",
  criteria: [],
});

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("待ちの上限を超えました");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Worker: 取り出しと順番", () => {
  test("古い順に1件ずつ処理し、入口が同時に2回呼ばれない（SC-007）", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [deferred<void>(), deferred<void>()];
    const order: number[] = [];
    const s = await setup({
      pipeline: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(input.jobId);
        await gates[order.length - 1]?.promise;
        active -= 1;
        return result("rejected");
      },
    });
    const later = s.enqueue(2, 2000);
    const earlier = s.enqueue(1, 1000);
    s.start();
    await waitFor(() => order.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([earlier.id]);
    gates[0]?.resolve();
    await waitFor(() => order.length === 2);
    gates[1]?.resolve();
    await waitFor(() => s.jobOf(later.id).status === "failed");
    expect(order).toEqual([earlier.id, later.id]);
    expect(maxActive).toBe(1);
  });

  test("wake で待ちを打ち切ってすぐ取り出す", async () => {
    const s = await setup();
    const worker = s.start();
    await new Promise((r) => setTimeout(r, 30));
    const job = s.enqueue(1);
    const started = Date.now();
    worker.wake();
    await waitFor(() => s.jobOf(job.id).status === "failed", 2000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("Worker: 入口に渡すもの", () => {
  test("作業ディレクトリ・Issue・依頼・期限を渡し、計画は渡さない。branch 列が入る", async () => {
    const s = await setup({
      github: { issue: { title: "題", body: "本文" } },
      jobTimeoutMs: 120_000,
    });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    const done = s.jobOf(job.id);
    const [input] = s.pipelineInputs;
    expect(input).toMatchObject({
      jobId: job.id,
      workdir: join(s.workDir, `job-${job.id}`, "repo"),
      issue: { title: "題", body: "本文" },
      instruction: "依頼 1",
      deadline: (done.started_at as number) + 120_000,
    });
    expect(input?.plan).toBeUndefined();
    expect(input?.signal).toBeInstanceOf(AbortSignal);
    expect(done.branch).toBe(`agent/issue-7-job-${job.id}`);
    expect(s.installs).toEqual([
      expect.objectContaining({ jobId: job.id, workdir: input?.workdir }),
    ]);
  });
});

describe("Worker: onPhase と状態", () => {
  test("同じ状態は記録せず、ほかは state_changed が1件ずつ残る。表にない遷移は warn だけ", async () => {
    const s = await setup({
      pipeline: async (input) => {
        const calls: [Parameters<NonNullable<PipelineInput["onPhase"]>>[0], number][] = [
          ["planning", 0],
          ["implementing", 1],
          ["testing", 1],
          ["implementing", 1],
          ["testing", 1],
          ["judging", 1],
          ["implementing", 2],
          ["implementing", 3],
        ];
        for (const [phase, round] of calls) input.onPhase?.(phase, round);
        return result("rejected");
      },
    });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    const transitions = s
      .eventsOf(job.id)
      .filter((e) => e.type === "state_changed")
      .map((e) => `${e.from_status}→${e.to_status}`);
    expect(transitions).toEqual([
      "planning→implementing",
      "implementing→testing",
      "testing→implementing",
      "implementing→testing",
      "testing→judging",
      "judging→implementing",
      "implementing→failed",
    ]);
  });

  test("表にない遷移は状態を変えず warn を残し、工程は続く", async () => {
    const s = await setup({
      pipeline: async (input) => {
        input.onPhase?.("judging", 1);
        return result("rejected");
      },
    });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    expect(s.jobOf(job.id).failure_reason).toMatch(/^judge_rejected: /);
    const transitions = s.eventsOf(job.id).filter((e) => e.type === "state_changed");
    expect(transitions.map((e) => e.to_status)).toEqual(["failed"]);
    expect(s.logs()).toContain('"level":40');
  });
});

describe("classifyOutcome", () => {
  test.each([
    ["rejected", "judge_rejected"],
    ["failed", "pipeline_failed"],
    ["budget_exceeded", "budget_exceeded"],
    ["timeout", "timeout"],
    ["aborted", "stopped"],
  ] as const)("%s → %s", (outcome, kind) => {
    expect(classifyOutcome(result(outcome, { verdict: verdict() })).kind).toBe(kind);
  });

  test("詳細: rejected は reason、failed は error", () => {
    expect(classifyOutcome(result("rejected", { reason: "テストが通らない" })).detail).toBe(
      "テストが通らない",
    );
    expect(classifyOutcome(result("failed", { error: "計画の形が合わない" })).detail).toBe(
      "計画の形が合わない",
    );
  });
});

describe("Worker: 結果の報告", () => {
  test.each([
    ["rejected", "judge_rejected", "最後の理由"],
    ["failed", "pipeline_failed", "作業場を作れません"],
    ["budget_exceeded", "budget_exceeded", "予算切れ"],
    ["timeout", "timeout", ""],
    ["aborted", "stopped", ""],
  ] as const)("%s は %s で failed、報告は1回", async (outcome, kind, detail) => {
    const s = await setup({
      pipeline: async () =>
        result(outcome, {
          verdict: verdict(),
          ...(outcome === "failed" ? { error: "作業場を作れません" } : {}),
          ...(outcome === "budget_exceeded" ? { error: "予算切れ" } : {}),
        }),
    });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    await waitFor(() => s.github.comments.length === 1);
    expect(s.jobOf(job.id).failure_reason).toMatch(new RegExp(`^${kind}: `));
    const body = s.github.comments[0]?.body ?? "";
    expect(body).toContain(`\`${kind}\``);
    expect(body).toContain("| やり直し・変更 | 1 回 / 2 ファイル（+5 −1） |");
    if (detail) expect(body).toContain(detail);
  });

  test("入口の例外は internal_error", async () => {
    const s = await setup({
      pipeline: async () => {
        throw new Error("予期しない例外");
      },
    });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    expect(s.jobOf(job.id).failure_reason).toMatch(/^internal_error: /);
  });
});

describe("Worker: 準備の失敗", () => {
  test("Issue を取れなければ clone_failed（止まった工程は「準備」）", async () => {
    const s = await setup({ github: { fail: { getIssue: new Error("404 Not Found") } } });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.github.comments.length === 1);
    expect(s.jobOf(job.id).failure_reason).toMatch(/^clone_failed: /);
    expect(s.github.comments[0]?.body).toContain("| 止まった工程 | 準備 |");
    expect(s.github.comments[0]?.body).toContain("| 作業ブランチ | なし |");
    expect(s.pipelineInputs).toEqual([]);
  });

  test("取得の失敗は clone_failed で、報告とログにトークンがない", async () => {
    const s = await setup();
    s.deps.cloneBaseUrl = "file:///nonexistent";
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.github.comments.length === 1);
    expect(s.jobOf(job.id).failure_reason).toMatch(/^clone_failed: /);
    expect(s.github.comments[0]?.body).not.toContain(TOKEN);
    expect(s.logs()).not.toContain(TOKEN);
  });

  test("インストールの終了コードが 0 以外なら install_failed（詳細に標準エラーの末尾）", async () => {
    const s = await setup({
      install: async () => ({ exitCode: 1, stderrTail: "ERR_PNPM_OUTDATED_LOCKFILE" }),
    });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.github.comments.length === 1);
    expect(s.jobOf(job.id).failure_reason).toMatch(/^install_failed: /);
    expect(s.github.comments[0]?.body).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    expect(s.github.comments[0]?.body).toContain("| 止まった工程 | 準備 |");
    expect(s.pipelineInputs).toEqual([]);
  });

  test("install_command が空ならインストールを呼ばずに入口へ進む", async () => {
    const s = await setup({ configExtra: '[pipeline]\ninstall_command = ""' });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    expect(s.installs).toEqual([]);
    expect(s.pipelineInputs).toHaveLength(1);
  });
});

describe("Worker: 期限", () => {
  test("準備の途中で期限を過ぎたら timeout", async () => {
    const s = await setup({ github: { delayMs: { getIssue: 500 } }, jobTimeoutMs: 50 });
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    expect(s.jobOf(job.id).failure_reason).toMatch(/^timeout: /);
    expect(s.pipelineInputs).toEqual([]);
  });

  test("インストール中に期限が来たら作業場を消して戻らせ、終了コードが 0 以外でも timeout", async () => {
    const release = deferred<void>();
    const s = await setup({
      jobTimeoutMs: 100,
      install: async () => {
        await release.promise;
        return { exitCode: 137, stderrTail: "killed" };
      },
    });
    const removeSandboxes = s.deps.removeSandboxes;
    s.deps.removeSandboxes = async (jobId) => {
      await removeSandboxes(jobId);
      release.resolve();
    };
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    expect(s.jobOf(job.id).failure_reason).toMatch(/^timeout: /);
    expect(s.removed).toContain(job.id);
  });
});

describe("Worker: 片付けとトークン", () => {
  test("どの終わり方でも作業ディレクトリが残らず、作業場の片付けが呼ばれる（SC-008）", async () => {
    const s = await setup({
      pipeline: async () => {
        throw new Error("x");
      },
    });
    const a = s.enqueue(1);
    const b = s.enqueue(2);
    s.deps.github = new FakeGitHub({ token: TOKEN });
    s.start();
    await waitFor(() => s.jobOf(b.id).status === "failed" && s.jobOf(a.id).status === "failed");
    await waitFor(() => s.removed.includes(b.id));
    expect(existsSync(join(s.workDir, `job-${a.id}`))).toBe(false);
    expect(existsSync(join(s.workDir, `job-${b.id}`))).toBe(false);
    expect(s.removed).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  test("install と入口に渡る作業ディレクトリの .git/config にトークンがなく、ログにも出ない（SC-006）", async () => {
    const s = await setup();
    const job = s.enqueue(1);
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    expect(s.installs[0]?.gitConfig).toBeDefined();
    expect(s.installs[0]?.gitConfig).not.toContain(TOKEN);
    expect(s.pipelineConfigs[0]).not.toContain(TOKEN);
    expect(s.pipelineConfigs[0]?.toLowerCase()).not.toContain("extraheader");
    expect(s.logs()).not.toContain(TOKEN);
    expect(s.github.comments.map((c) => c.body).join("")).not.toContain(TOKEN);
  });
});

describe("Worker: 出荷（008）", () => {
  test("合格したら出荷に進み、ci_waiting で終え、作業ディレクトリを片付けて次のジョブを取り出す", async () => {
    const s = await setup({
      pipeline: async (input) => {
        // 本物の 005 と同じく、工程の境目で onPhase を呼ぶ
        for (const phase of ["implementing", "testing", "judging"] as const)
          input.onPhase?.(phase, 1);
        writeFileSync(join(input.workdir, "README.md"), `# demo\n\n${input.jobId}\n`);
        return result("passed", {
          verdict: verdict(),
          plan: {
            summary: "README を直す",
            steps: ["直す"],
            acceptance_criteria: ["直っている"],
            work_type: "docs",
          },
        });
      },
    });
    const first = s.enqueue(1);
    const second = s.enqueue(2);
    s.start();
    await waitFor(() => s.jobOf(second.id).status === "ci_waiting", 30_000);
    expect(s.jobOf(first.id)).toMatchObject({ status: "ci_waiting", pr_number: 1 });
    expect(s.jobOf(second.id)).toMatchObject({ status: "ci_waiting", pr_number: 2 });
    expect(s.github.pullRequests.map((p) => p.autoMerge)).toEqual([true, true]);
    expect(s.github.comments.map((c) => c.body)).toEqual([
      expect.stringContaining("/pull/1"),
      expect.stringContaining("/pull/2"),
    ]);
    await waitFor(() => readdirSync(s.workDir).length === 0);
  }, 60_000);
});

describe("recoverOnStartup と stop（US5）", () => {
  test("planning〜judging を failed（restarted）にして各1回報告し、queued・pr_opened・ci_waiting には触らない", async () => {
    const s = await setup();
    const ids = [
      "queued",
      "planning",
      "implementing",
      "testing",
      "judging",
      "pr_opened",
      "ci_waiting",
    ].map((status, i) => {
      const job = s.enqueue(i + 1);
      s.db
        .update(jobs)
        .set({ status: status as Job["status"] })
        .where(eq(jobs.id, job.id))
        .run();
      return job.id;
    });
    mkdirSync(join(s.workDir, "job-99", "repo"), { recursive: true });
    mkdirSync(join(s.workDir, "keep-me"), { recursive: true });

    const { failedJobs } = await recoverOnStartup(s.deps);
    expect(failedJobs).toBe(4);
    expect(ids.map((id) => s.jobOf(id).status)).toEqual([
      "queued",
      "failed",
      "failed",
      "failed",
      "failed",
      "pr_opened",
      "ci_waiting",
    ]);
    expect(s.github.comments).toHaveLength(4);
    for (const id of ids.slice(1, 5)) {
      expect(s.jobOf(id).failure_reason).toMatch(/^restarted: /);
    }
    expect(readdirSync(s.workDir)).toEqual(["keep-me"]);
    expect(s.removed).toContain(undefined);
  });

  test("ci_waiting（pending・passed・failed）は残し、やり直しの途中で中断したジョブは restarted で PR を Draft に（009）", async () => {
    const s = await setup();
    const statuses = ["pending", "passed", "failed"] as const;
    const waiting = statuses.map((ci, i) => {
      const job = s.enqueue(i + 1);
      s.db
        .update(jobs)
        .set({ status: "ci_waiting", ci_status: ci, pr_number: i + 1 })
        .where(eq(jobs.id, job.id))
        .run();
      return job.id;
    });
    const retrying = s.enqueue(9);
    s.db
      .update(jobs)
      .set({ status: "implementing", pr_number: 9, ci_retries: 1 })
      .where(eq(jobs.id, retrying.id))
      .run();
    s.github.addPullRequest({ number: 9, repo: "octo-org/demo", autoMerge: true });

    const { failedJobs } = await recoverOnStartup(s.deps);
    expect(failedJobs).toBe(1);
    expect(waiting.map((id) => s.jobOf(id).status)).toEqual([
      "ci_waiting",
      "ci_waiting",
      "ci_waiting",
    ]);
    expect(s.jobOf(retrying.id).failure_reason).toMatch(/^restarted: /);
    expect(s.github.pullRequests[0]?.draft).toBe(true);
  });

  test("stop() で取り出しが止まり、処理中のジョブは中断されて stopped になってから resolve", async () => {
    let signal: AbortSignal | undefined;
    const s = await setup({
      pipeline: (input) =>
        new Promise((resolve) => {
          signal = input.signal;
          input.signal?.addEventListener("abort", () => resolve(result("aborted")));
        }),
    });
    const job = s.enqueue(1);
    const next = s.enqueue(2);
    const worker = s.start();
    await waitFor(() => signal !== undefined);
    await worker.stop();
    expect(signal?.aborted).toBe(true);
    expect(s.jobOf(job.id).status).toBe("failed");
    expect(s.jobOf(job.id).failure_reason).toMatch(/^stopped: /);
    expect(s.github.comments).toHaveLength(1);
    expect(s.jobOf(next.id).status).toBe("queued");
  });

  test("インストール中に stop() すると作業場を消して戻らせ、stopped になる", async () => {
    const release = deferred<void>();
    let installing = false;
    const s = await setup({
      install: async () => {
        installing = true;
        await release.promise;
        return { exitCode: 137, stderrTail: "" };
      },
    });
    const removeSandboxes = s.deps.removeSandboxes;
    s.deps.removeSandboxes = async (jobId) => {
      await removeSandboxes(jobId);
      release.resolve();
    };
    const job = s.enqueue(1);
    const worker = s.start();
    await waitFor(() => installing);
    await worker.stop();
    expect(s.jobOf(job.id).failure_reason).toMatch(/^stopped: /);
    expect(s.removed).toContain(job.id);
  });

  test("入口が stopTimeoutMs を過ぎても戻らなければ、状態を変えずに resolve し、次の起動で restarted として1回報告される", async () => {
    let entered = false;
    const s = await setup({
      stopTimeoutMs: 50,
      pipeline: async (input) => {
        entered = true;
        input.onPhase?.("implementing", 1);
        return new Promise(() => {});
      },
    });
    const job = s.enqueue(1);
    const worker = s.start();
    await waitFor(() => entered);
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s.jobOf(job.id).status).toBe("implementing");
    expect(s.github.comments).toEqual([]);

    await recoverOnStartup(s.deps);
    expect(s.jobOf(job.id).failure_reason).toMatch(/^restarted: /);
    expect(s.github.comments).toHaveLength(1);
  });

  test("処理中のジョブがなければ stop() はすぐ resolve", async () => {
    const s = await setup();
    const worker = s.start();
    const started = Date.now();
    await worker.stop();
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("Worker: CI 失敗後のやり直し（009）", () => {
  const PLAN = {
    summary: "README を直す",
    steps: ["直す"],
    acceptance_criteria: ["直っている"],
    work_type: "docs" as const,
  };

  /** 1回目は出荷まで、2回目以降は retry の挙動で回す */
  async function shippedThenFailed(
    retry: (input: Omit<PipelineInput, "workspace">) => Promise<PipelineResult>,
  ) {
    let calls = 0;
    const s = await setup({
      pipeline: async (input) => {
        calls += 1;
        for (const phase of ["implementing", "testing", "judging"] as const)
          input.onPhase?.(phase, 1);
        if (calls === 1) {
          writeFileSync(join(input.workdir, "README.md"), "# demo\n\n直した\n");
          return result("passed", { verdict: verdict(), plan: PLAN, planText: "計画の文" });
        }
        return retry(input);
      },
    });
    const job = s.enqueue(1);
    const worker = s.start();
    await waitFor(() => s.jobOf(job.id).status === "ci_waiting", 30_000);
    const shipped = s.jobOf(job.id);
    s.github.setCheckRuns(shipped.head_sha as string, [
      { id: 11, name: "test", status: "completed", conclusion: "failure", app: "github-actions" },
      { id: 12, name: "lint", status: "completed", conclusion: "success", app: "github-actions" },
    ]);
    s.github.options.checkLogs = { 11: "2026-11-14T00:00:00Z ##[error]expected 2 but got 3" };
    return { ...s, job, worker, shipped };
  }

  test("CI の失敗をログ付きで入口に渡し、同じ PR に追加の push をして ci_waiting に戻る", async () => {
    const before = Date.now();
    const s = await shippedThenFailed(async (input) => {
      writeFileSync(join(input.workdir, "README.md"), "# demo\n\n直した（CI も）\n");
      return result("passed", { verdict: verdict(), plan: PLAN, planText: "計画の文" });
    });
    s.db.update(jobs).set({ ci_status: "failed" }).where(eq(jobs.id, s.job.id)).run();
    s.worker.wake();
    await waitFor(
      () => s.jobOf(s.job.id).ci_retries === 1 && s.jobOf(s.job.id).status === "ci_waiting",
      30_000,
    );

    const input = s.pipelineInputs[1];
    expect(input).toMatchObject({
      plan: "計画の文",
      planObject: PLAN,
      baseCommit: s.shipped.base_sha,
      preflightChecks: true,
    });
    expect(input?.deadline).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(input?.initialFeedback?.[0]?.body).toContain(
      '<ci_log name="test" conclusion="failure">',
    );
    expect(input?.initialFeedback?.[0]?.body).toContain("##[error]expected 2 but got 3");
    expect(input?.initialFeedback?.[0]?.body).not.toContain("2026-11-14T00:00:00Z");
    expect(input?.initialFeedback?.[1]?.body).toContain("+直した");

    const after = s.jobOf(s.job.id);
    expect(after).toMatchObject({ status: "ci_waiting", ci_status: "pending", pr_number: 1 });
    expect(after.head_sha).not.toBe(s.shipped.head_sha);
    expect(s.github.count("createPullRequest")).toBe(1);
    expect(s.github.comments).toHaveLength(1);
    expect(s.github.pullRequests[0]?.body).toContain("🔁 やり直しを push");
    await waitFor(() => readdirSync(s.workDir).length === 0);
  }, 60_000);

  test("やり直しが不合格なら judge_rejected で failed、PR を Draft に", async () => {
    const s = await shippedThenFailed(async () => result("rejected", { reason: "直っていない" }));
    s.db.update(jobs).set({ ci_status: "failed" }).where(eq(jobs.id, s.job.id)).run();
    s.worker.wake();
    await waitFor(() => s.jobOf(s.job.id).status === "failed", 30_000);
    expect(s.jobOf(s.job.id).failure_reason).toMatch(/^judge_rejected: /);
    expect(s.github.pullRequests[0]?.draft).toBe(true);
    expect(s.github.comments).toHaveLength(2);
  }, 60_000);

  test("やり直しを新しい依頼より先に取り出す", async () => {
    const s = await shippedThenFailed(async (input) => {
      writeFileSync(join(input.workdir, "README.md"), `# demo\n\n${input.jobId}\n`);
      return result("passed", { verdict: verdict(), plan: PLAN, planText: "計画の文" });
    });
    await s.worker.stop();
    const fresh = s.enqueue(2);
    s.db.update(jobs).set({ ci_status: "failed" }).where(eq(jobs.id, s.job.id)).run();
    s.start();
    await waitFor(() => s.jobOf(fresh.id).status === "ci_waiting", 30_000);
    expect(s.pipelineInputs.map((i) => i.jobId)).toEqual([s.job.id, s.job.id, fresh.id]);
  }, 60_000);

  test("出荷の記録がなければ internal_error", async () => {
    const s = await setup();
    const job = s.enqueue(1);
    s.db
      .update(jobs)
      .set({
        status: "ci_waiting",
        ci_status: "failed",
        branch: "agent/issue-7-job-1",
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        pr_number: 4,
      })
      .where(eq(jobs.id, job.id))
      .run();
    s.github.addPullRequest({ number: 4, repo: "octo-org/demo" });
    s.start();
    await waitFor(() => s.jobOf(job.id).status === "failed");
    expect(s.jobOf(job.id).failure_reason).toMatch(/^internal_error: .*shipped/);
    expect(s.pipelineInputs).toHaveLength(0);
  });
});
