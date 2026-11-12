import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { openDatabase, runMigrations } from "./db.ts";
import { claimNextQueuedJob, enqueueJob, listInterruptedJobs, markIntakeStopped } from "./jobs.ts";
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
