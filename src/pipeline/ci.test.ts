import { Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { parseConfig } from "../config.ts";
import type { CheckRunInfo } from "../github/port.ts";
import { FakeGitHub } from "../github/testing.ts";
import { createLogger } from "../log.ts";
import { type CiStatus, type JobStatus, jobEvents, jobs } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { checkCiJob, concludeCi, createCiMonitor } from "./ci.ts";

const configText = (ciRetries = 2) => `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"
[models]
planner = "p"
implementer = "i"
verifier = "v"
fallback = "f"
[budget]
monthly_requests = 100
per_job_requests = 10
[limits]
ci_retries = ${ciRetries}
ci_wait_timeout_minutes = 30
[github]
allowed_users = ["octo-requester"]
`;

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PR_BODY =
  "まとめ\n\n<!-- factory:ci -->\n#### CI\nCI の結果を待っています\n<!-- /factory:ci -->";

const run = (name: string, status: string, conclusion: string | null): CheckRunInfo => ({
  id: name.length,
  name,
  status,
  conclusion,
  app: "github-actions",
});

function setup(
  options: {
    ciRetries?: number;
    ciStatus?: CiStatus;
    ciRetriesUsed?: number;
    status?: JobStatus;
    deadline?: number;
    now?: number;
    draft?: boolean;
  } = {},
) {
  const handle = migratedMemoryDb();
  const config = parseConfig(configText(options.ciRetries), "/srv/factory");
  const logger = createLogger(
    { level: "fatal" },
    new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }),
  );
  const github = new FakeGitHub();
  github.addPullRequest({
    number: 3,
    repo: "octo-org/demo",
    headSha: HEAD,
    body: PR_BODY,
    autoMerge: !options.draft,
    draft: options.draft ?? false,
  });
  let clock = options.now ?? 1000;
  const job = handle.db
    .insert(jobs)
    .values({
      repo: "octo-org/demo",
      issue_number: 7,
      trigger_comment_id: 1,
      requested_by: "octo-requester",
      instruction: "直して",
      status: options.status ?? "ci_waiting",
      branch: "agent/issue-7-job-1",
      pr_number: 3,
      base_sha: "base",
      head_sha: HEAD,
      ci_status: options.ciStatus ?? "pending",
      ci_retries: options.ciRetriesUsed ?? 0,
      ci_deadline: options.deadline ?? 5000,
      ci_event_at: 900,
      created_at: 1,
      updated_at: 1,
    })
    .returning()
    .get();
  const wakeWorker = vi.fn();
  const deps = {
    db: handle.db,
    config,
    logger,
    github,
    now: () => clock,
    wakeWorker,
  };
  const current = () => handle.db.select().from(jobs).get();
  const notes = (kind?: string) =>
    handle.db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.type === "note")
      .map((e) => JSON.parse(e.detail ?? "{}"))
      .filter((d) => kind === undefined || d.kind === kind);
  return {
    ...handle,
    deps,
    github,
    job,
    wakeWorker,
    current,
    notes,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

describe("concludeCi", () => {
  test("0件・途中があれば pending", () => {
    expect(concludeCi([])).toEqual({ kind: "pending" });
    expect(
      concludeCi([run("a", "completed", "success"), run("b", "in_progress", null)]),
    ).toEqual({ kind: "pending" });
    expect(concludeCi([run("a", "queued", null)])).toEqual({ kind: "pending" });
  });

  test("成功・中立・スキップだけなら success", () => {
    expect(
      concludeCi([
        run("a", "completed", "success"),
        run("b", "completed", "neutral"),
        run("c", "completed", "skipped"),
      ]),
    ).toEqual({ kind: "success" });
  });

  test.each(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"])(
    "%s が1つでもあれば failure",
    (conclusion) => {
      expect(
        concludeCi([run("ok", "completed", "success"), run("bad", "completed", conclusion)]),
      ).toEqual({ kind: "failure", failed: [{ name: "bad", conclusion }] });
    },
  );
});

describe("checkCiJob: 通過・マージ・閉じた（US1）", () => {
  test("すべて成功なら passed にし、ci_result と CI の欄を書く。状態は ci_waiting のまま", async () => {
    const ctx = setup();
    ctx.github.setCheckRuns(HEAD, [run("test", "completed", "success")]);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("passed");
    expect(ctx.current()).toMatchObject({
      status: "ci_waiting",
      ci_status: "passed",
      ci_event_at: null,
    });
    expect(ctx.notes("ci_result")).toEqual([
      { kind: "ci_result", head_sha: HEAD, conclusion: "success", failed: [], attempt: 1 },
    ]);
    const body = ctx.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("| 1 | `0123456` | ✅ 通過 | |");
    expect(body.startsWith("まとめ\n\n<!-- factory:ci -->")).toBe(true);
  });

  test("片方だけ終わっていれば pending で記録なし。印は消える", async () => {
    const ctx = setup();
    ctx.github.setCheckRuns(HEAD, [
      run("test", "completed", "success"),
      run("lint", "in_progress", null),
    ]);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("pending");
    expect(ctx.current()).toMatchObject({ ci_status: "pending", ci_event_at: null });
    expect(ctx.notes("ci_result")).toEqual([]);
    expect(ctx.github.count("updatePullRequestBody")).toBe(0);
  });

  test("評価中に新しい知らせが届いたら、その印は消さない", async () => {
    const ctx = setup();
    ctx.github.setCheckRuns(HEAD, []);
    ctx.db.update(jobs).set({ ci_event_at: 950 }).run();
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("pending");
    expect(ctx.current()?.ci_event_at).toBe(950);
  });

  test("同じジョブを2回評価しても ci_result と本文の更新は1回", async () => {
    const ctx = setup();
    ctx.github.setCheckRuns(HEAD, [run("test", "completed", "success")]);
    await checkCiJob(ctx.deps, ctx.job);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("skipped");
    expect(ctx.notes("ci_result")).toHaveLength(1);
    expect(ctx.github.count("updatePullRequestBody")).toBe(1);
  });

  test("PR がマージ済みなら merged に進め、CI の欄に書く（CI 通過のあとも）", async () => {
    const ctx = setup({ ciStatus: "passed" });
    ctx.github.mergePullRequest(3);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("merged");
    expect(ctx.current()).toMatchObject({ status: "merged", ci_event_at: null });
    expect(ctx.notes("merged")).toEqual([{ kind: "merged", pr_number: 3 }]);
    expect(ctx.github.pullRequests[0]?.body).toContain("🎉 マージ");
    expect(ctx.github.comments).toHaveLength(0);
  });

  test("マージされずに閉じたら failed（pr_closed）、Issue に1回、Draft には変えない", async () => {
    const ctx = setup();
    ctx.github.closePullRequest(3);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("closed");
    expect(await checkCiJob(ctx.deps, { ...ctx.job, status: "failed" })).toBe("skipped");
    expect(ctx.current()).toMatchObject({ status: "failed" });
    expect(ctx.current()?.failure_reason).toMatch(/^pr_closed: /);
    expect(ctx.github.comments).toHaveLength(1);
    expect(ctx.github.comments[0]?.body).toContain("PR がマージされずに閉じられました");
    expect(ctx.github.count("convertToDraft")).toBe(0);
  });

  test("passed のジョブはチェックを取らずに印だけ消す", async () => {
    const ctx = setup({ ciStatus: "passed" });
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("skipped");
    expect(ctx.github.count("getCheckRuns")).toBe(0);
    expect(ctx.current()?.ci_event_at).toBeNull();
  });

  test("GitHub を呼べなければ印を残して skipped", async () => {
    const ctx = setup();
    ctx.github.options.fail = { getCheckRuns: new Error("502") };
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("skipped");
    expect(ctx.current()).toMatchObject({ ci_status: "pending", ci_event_at: 900 });
  });

  test("本文の更新に失敗しても ci_body_failed を残して状態は進む", async () => {
    const ctx = setup();
    ctx.github.setCheckRuns(HEAD, [run("test", "completed", "success")]);
    ctx.github.options.fail = { updatePullRequestBody: new Error("403") };
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("passed");
    expect(ctx.current()?.ci_status).toBe("passed");
    const errors = ctx.db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.type === "error")
      .map((e) => JSON.parse(e.detail ?? "{}").kind);
    expect(errors).toEqual(["ci_body_failed"]);
  });

  test("CI 初回通過を ci_result の attempt から SQL で集計できる（SC-008）", async () => {
    const ctx = setup();
    ctx.github.setCheckRuns(HEAD, [run("test", "completed", "success")]);
    await checkCiJob(ctx.deps, ctx.job);
    const row = ctx.sqlite
      .prepare(
        "SELECT json_extract(detail, '$.conclusion') AS conclusion FROM job_events WHERE json_extract(detail, '$.kind') = 'ci_result' AND json_extract(detail, '$.attempt') = 1",
      )
      .get() as { conclusion: string };
    expect(row.conclusion).toBe("success");
  });
});

describe("checkCiJob: 失敗（US2）", () => {
  const failing = [run("test", "completed", "failure"), run("lint", "completed", "success")];

  test("上限未満ならやり直しの印を付け、Worker を起こし、CI の欄に失敗を書く", async () => {
    const ctx = setup({ ciRetriesUsed: 1 });
    ctx.github.setCheckRuns(HEAD, failing);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("retry");
    expect(ctx.current()).toMatchObject({ status: "ci_waiting", ci_status: "failed" });
    expect(ctx.wakeWorker).toHaveBeenCalledTimes(1);
    expect(ctx.notes("ci_result")[0]).toMatchObject({
      conclusion: "failure",
      attempt: 2,
      failed: [{ name: "test", conclusion: "failure" }],
    });
    expect(ctx.github.pullRequests[0]?.body).toContain("| 2 | `0123456` | ❌ 失敗 | `test`（failure） |");
    expect(ctx.github.comments).toHaveLength(0);
  });

  test("上限に達していれば failed（ci_failed）、Issue に失敗したチェック、PR を Draft、欄に 🛑", async () => {
    const ctx = setup({ ciRetriesUsed: 2 });
    ctx.github.setCheckRuns(HEAD, failing);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("failed");
    expect(ctx.current()?.status).toBe("failed");
    expect(ctx.current()?.failure_reason).toMatch(/^ci_failed: /);
    expect(ctx.wakeWorker).not.toHaveBeenCalled();
    expect(ctx.github.comments).toHaveLength(1);
    expect(ctx.github.comments[0]?.body).toContain("- `test`（failure）");
    expect(ctx.github.comments[0]?.body).toContain("| CI のやり直し | 2 / 上限 2 |");
    expect(ctx.github.pullRequests[0]?.draft).toBe(true);
    const body = ctx.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("❌ 失敗");
    expect(body).toContain("🛑 ファクトリーは作業を止めました");
  });

  test("ci_retries = 0 の設定なら1回目の失敗から failed", async () => {
    const ctx = setup({ ciRetries: 0 });
    ctx.github.setCheckRuns(HEAD, failing);
    expect(await checkCiJob(ctx.deps, ctx.job)).toBe("failed");
    expect(ctx.current()?.failure_reason).toMatch(/^ci_failed: /);
  });
});

describe("checkCiJob: 時間切れ（US3）", () => {
  test("期限切れでチェックが途中・0件なら failed（ci_timeout）、Draft、Issue に1回", async () => {
    for (const runs of [[run("test", "in_progress", null)], []]) {
      const ctx = setup({ now: 6000, deadline: 5000 });
      ctx.github.setCheckRuns(HEAD, runs);
      expect(await checkCiJob(ctx.deps, ctx.job)).toBe("timeout");
      expect(ctx.current()?.failure_reason).toMatch(/^ci_timeout: /);
      expect(ctx.github.comments).toHaveLength(1);
      expect(ctx.github.comments[0]?.body).toContain("CI の結論が 30 分以内に出ませんでした");
      expect(ctx.github.pullRequests[0]?.draft).toBe(true);
      expect(ctx.github.pullRequests[0]?.body).toContain("⌛ CI 待ちの時間切れ（30 分）");
    }
  });

  test("期限切れでも取り直して失敗・通過ならそれに従う", async () => {
    const failed = setup({ now: 6000, deadline: 5000 });
    failed.github.setCheckRuns(HEAD, [run("test", "completed", "failure")]);
    expect(await checkCiJob(failed.deps, failed.job)).toBe("retry");
    const passed = setup({ now: 6000, deadline: 5000 });
    passed.github.setCheckRuns(HEAD, [run("test", "completed", "success")]);
    expect(await checkCiJob(passed.deps, passed.job)).toBe("passed");
  });
});

describe("createCiMonitor", () => {
  test("start で pending のジョブに印を付けて評価し、passed は期限を過ぎても見ない", async () => {
    const ctx = setup({ now: 6000, deadline: 5000 });
    ctx.db.update(jobs).set({ ci_event_at: null }).run();
    ctx.github.setCheckRuns(HEAD, [run("test", "completed", "success")]);
    const monitor = createCiMonitor({ ...ctx.deps, intervalMs: 60_000 });
    monitor.start();
    await vi.waitFor(() => expect(ctx.current()?.ci_status).toBe("passed"));
    const calls = ctx.github.count("getPullRequest");
    monitor.wake();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.github.count("getPullRequest")).toBe(calls);
    await monitor.stop();
  });

  test("wake で待ちを打ち切って、受付が印を付けたジョブをすぐ評価する", async () => {
    const ctx = setup();
    ctx.db.update(jobs).set({ ci_event_at: null }).run();
    ctx.github.setCheckRuns(HEAD, []);
    const monitor = createCiMonitor({ ...ctx.deps, intervalMs: 60_000 });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.github.setCheckRuns(HEAD, [run("test", "completed", "success")]);
    ctx.db.update(jobs).set({ ci_event_at: 1000 }).run();
    monitor.wake();
    await vi.waitFor(() => expect(ctx.current()?.ci_status).toBe("passed"));
    await monitor.stop();
  });

  test("ci_check_interval_seconds の値で間隔が決まる", async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup({ now: 1000, deadline: 1_000_000 });
      ctx.db.update(jobs).set({ ci_event_at: null }).run();
      const monitor = createCiMonitor(ctx.deps);
      monitor.start();
      await vi.advanceTimersByTimeAsync(10);
      // 期限切れにして、間隔（既定 60 秒）のあとに見回ることを確かめる
      ctx.setClock(2_000_000);
      ctx.github.setCheckRuns(HEAD, []);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(ctx.current()?.status).toBe("ci_waiting");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ctx.current()?.status).toBe("failed");
      const stopped = monitor.stop();
      await vi.advanceTimersByTimeAsync(10);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });
});
