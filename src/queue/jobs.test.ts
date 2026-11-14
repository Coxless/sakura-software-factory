import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { openDatabase, runMigrations } from "./db.ts";
import {
  claimNextJob,
  claimNextQueuedJob,
  enqueueJob,
  listCiJobsToCheck,
  listInterruptedJobs,
  markIntakeStopped,
  markPendingCiJobs,
  noteCiEvent,
} from "./jobs.ts";
import { budget, JOB_STATUSES, jobEvents, jobs, type NewJob } from "./schema.ts";
import { migratedMemoryDb } from "./testing.ts";

const job = (commentId: number, createdAt: number): NewJob => ({
  repo: "Coxless/demo",
  issue_number: 1,
  trigger_comment_id: commentId,
  requested_by: "Coxless",
  instruction: "i",
  created_at: createdAt,
  updated_at: createdAt,
});

describe("claimNextQueuedJob", () => {
  test("最も古い queued を1件だけ planning にして返す", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(jobs)
      .values([job(1, 30), job(2, 10), job(3, 10)])
      .run();

    const first = claimNextQueuedJob(db, 1000);
    expect(first).toMatchObject({
      trigger_comment_id: 2,
      status: "planning",
      started_at: 1000,
      updated_at: 1000,
    });
    expect(claimNextQueuedJob(db, 1001)?.trigger_comment_id).toBe(3);
    expect(claimNextQueuedJob(db, 1002)?.trigger_comment_id).toBe(1);
    expect(claimNextQueuedJob(db, 1003)).toBeUndefined();
    close();
  });

  test("同じ DB を開いた2つの接続から取り出しても同じジョブを二度返さない", () => {
    const path = join(mkdtempSync(join(tmpdir(), "factory-jobs-")), "factory.db");
    const a = openDatabase(path);
    runMigrations(a.db);
    const b = openDatabase(path);
    a.db
      .insert(jobs)
      .values(Array.from({ length: 20 }, (_, i) => job(i + 1, i)))
      .run();

    const claimed: number[] = [];
    for (let i = 0; i < 12; i++) {
      const handle = i % 2 === 0 ? a : b;
      const next = claimNextQueuedJob(handle.db, 100 + i);
      if (next) claimed.push(next.id);
    }
    expect(claimed).toHaveLength(12);
    expect(new Set(claimed).size).toBe(12);
    a.close();
    b.close();
  });
});

const CONFIG = parseConfig(
  `
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
[github]
allowed_users = ["octo-requester"]
`,
  "/srv/factory",
);

const request = (commentId: number) => ({
  repo: "octo-org/demo",
  issue_number: 7,
  trigger_comment_id: commentId,
  requested_by: "octo-requester",
  instruction: "README を直して",
});

describe("enqueueJob", () => {
  test("queued で積み、created: true", () => {
    const { db, close } = migratedMemoryDb();
    const { job, created } = enqueueJob(db, request(11), 500);
    expect(created).toBe(true);
    expect(job).toMatchObject({
      ...request(11),
      status: "queued",
      created_at: 500,
      updated_at: 500,
      started_at: null,
    });
    close();
  });

  test("同じ (repo, trigger_comment_id) の2回目は積まずに既存のジョブを返す", () => {
    const { db, close } = migratedMemoryDb();
    const first = enqueueJob(db, request(11), 500);
    const second = enqueueJob(db, { ...request(11), instruction: "別の本文" }, 600);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.instruction).toBe("README を直して");
    expect(db.select().from(jobs).all()).toHaveLength(1);
    close();
  });

  test("note を渡すと、新しく積んだときだけ job_events に note を書く", () => {
    const { db, close } = migratedMemoryDb();
    const { job } = enqueueJob(db, request(11), 500, { kind: "accepted", delivery: "d-1" });
    enqueueJob(db, request(11), 600, { kind: "accepted", delivery: "d-2" });
    expect(db.select().from(jobEvents).all()).toEqual([
      expect.objectContaining({
        job_id: job.id,
        type: "note",
        detail: JSON.stringify({ kind: "accepted", delivery: "d-1" }),
        created_at: 500,
      }),
    ]);
    close();
  });

  test("別のリポジトリなら同じコメントの ID でも別のジョブ", () => {
    const { db, close } = migratedMemoryDb();
    enqueueJob(db, request(11), 500);
    const other = enqueueJob(db, { ...request(11), repo: "octo-org/other" }, 500);
    expect(other.created).toBe(true);
    close();
  });
});

describe("markIntakeStopped", () => {
  test("その月の intake_stopped_at を1回だけ書く", () => {
    const { db, close } = migratedMemoryDb();
    const now = Date.UTC(2026, 10, 12, 3);
    markIntakeStopped(db, CONFIG, now);
    markIntakeStopped(db, CONFIG, now + 1000);
    const rows = db.select().from(budget).all();
    expect(rows).toEqual([
      expect.objectContaining({ month: "2026-11", monthly_limit: 100, intake_stopped_at: now }),
    ]);
    close();
  });
});

describe("listInterruptedJobs", () => {
  test("planning〜judging だけを返す", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(jobs)
      .values(JOB_STATUSES.map((status, i) => ({ ...job(i + 1, i), status })))
      .run();
    const statuses = listInterruptedJobs(db).map((j) => j.status);
    expect(statuses.sort()).toEqual(["implementing", "judging", "planning", "testing"]);
    close();
  });
});

// ---- 009: CI の待ち ----

const waiting = (commentId: number, overrides: Partial<NewJob> = {}): NewJob => ({
  ...job(commentId, commentId),
  status: "ci_waiting",
  branch: `agent/issue-1-job-${commentId}`,
  pr_number: commentId,
  head_sha: `sha-${commentId}`,
  base_sha: "base",
  ci_status: "pending",
  ci_deadline: 10_000,
  ...overrides,
});

describe("claimNextJob（009）", () => {
  test("やり直しを待つ ci_waiting を queued より先に implementing にする", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(jobs)
      .values([
        job(1, 1),
        waiting(2, { ci_status: "failed", updated_at: 50 }),
        waiting(3, { ci_status: "pending" }),
      ])
      .run();
    const first = claimNextJob(db, 1000);
    expect(first?.kind).toBe("ci_retry");
    expect(first?.job).toMatchObject({
      trigger_comment_id: 2,
      status: "implementing",
      ci_retries: 1,
      ci_status: null,
      ci_deadline: null,
      updated_at: 1000,
    });
    const event = db.select().from(jobEvents).all().at(-1);
    expect(event).toMatchObject({ from_status: "ci_waiting", to_status: "implementing" });
    expect(JSON.parse(event?.detail ?? "{}")).toEqual({ reason: "ci_retry", ci_retry: 1 });

    const second = claimNextJob(db, 1001);
    expect(second?.kind).toBe("new");
    expect(second?.job).toMatchObject({ trigger_comment_id: 1, status: "planning" });
    expect(claimNextJob(db, 1002)).toBeUndefined();
    close();
  });

  test("やり直しを待つジョブが複数あれば古い順", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(jobs)
      .values([
        waiting(1, { ci_status: "failed", updated_at: 90 }),
        waiting(2, { ci_status: "failed", updated_at: 20 }),
      ])
      .run();
    expect(claimNextJob(db, 1000)?.job.trigger_comment_id).toBe(2);
    close();
  });
});

describe("noteCiEvent（009）", () => {
  test("check_suite は branch と head_sha が一致する ci_waiting にだけ印を付ける", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(jobs)
      .values([waiting(1), waiting(2, { status: "implementing", ci_status: null })])
      .run();
    const base = { kind: "check_suite", repo: "Coxless/demo" } as const;
    expect(
      noteCiEvent(db, { ...base, headBranch: "agent/issue-1-job-1", headSha: "other" }, 5, "d1"),
    ).toBeUndefined();
    expect(
      noteCiEvent(db, { ...base, headBranch: "agent/issue-1-job-2", headSha: "sha-2" }, 5, "d2"),
    ).toBeUndefined();
    expect(
      noteCiEvent(db, { ...base, headBranch: null, headSha: "sha-1" }, 5, "d3"),
    ).toBeUndefined();
    const noted = noteCiEvent(
      db,
      { ...base, headBranch: "agent/issue-1-job-1", headSha: "sha-1" },
      7,
      "d4",
    );
    expect(noted).toMatchObject({ trigger_comment_id: 1, ci_event_at: 7 });
    const events = db.select().from(jobEvents).all();
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.detail ?? "{}")).toEqual({
      kind: "ci_event",
      event: "check_suite",
      delivery: "d4",
      head_sha: "sha-1",
    });
    close();
  });

  test("pull_request_closed は pr_number が一致する ci_waiting に印を付ける", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(jobs).values([waiting(3)]).run();
    const ev = { kind: "pull_request_closed", repo: "Coxless/demo", merged: true } as const;
    expect(noteCiEvent(db, { ...ev, prNumber: 4 }, 5, "d")).toBeUndefined();
    expect(noteCiEvent(db, { ...ev, repo: "x/y", prNumber: 3 }, 5, "d")).toBeUndefined();
    expect(noteCiEvent(db, { ...ev, prNumber: 3 }, 9, "d")?.ci_event_at).toBe(9);
    close();
  });
});

describe("listCiJobsToCheck・markPendingCiJobs（009）", () => {
  test("印のあるもの、pending で期限切れのものを古い順に返す", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(jobs)
      .values([
        waiting(1, { ci_deadline: 100 }),
        waiting(2, { ci_deadline: 5000 }),
        waiting(3, { ci_deadline: 100, ci_status: "passed" }),
        waiting(4, { ci_deadline: 5000, ci_status: "passed", ci_event_at: 3 }),
        waiting(5, { ci_deadline: 100, ci_status: "failed" }),
        waiting(6, { status: "implementing", ci_status: null, ci_event_at: 3 }),
      ])
      .run();
    expect(listCiJobsToCheck(db, 1000).map((j) => j.trigger_comment_id)).toEqual([1, 4]);

    expect(markPendingCiJobs(db, 2000)).toBe(2);
    expect(listCiJobsToCheck(db, 1000).map((j) => j.trigger_comment_id)).toEqual([1, 2, 4]);
    close();
  });
});
