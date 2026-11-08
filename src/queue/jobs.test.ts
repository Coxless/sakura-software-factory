import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDatabase, runMigrations } from "./db.ts";
import { claimNextQueuedJob } from "./jobs.ts";
import { jobs, type NewJob } from "./schema.ts";
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
