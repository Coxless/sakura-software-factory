import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { JOB_STATUSES, type JobStatus, jobEvents, jobs } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { canTransition, StateTransitionError, TRANSITIONS, transition } from "./state.ts";

/** data-model.md の遷移の表（failed へはここに書かず、下で別に扱う） */
const EXPECTED: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["planning"],
  planning: ["implementing"],
  implementing: ["testing"],
  testing: ["implementing", "judging"],
  judging: ["implementing", "pr_opened"],
  pr_opened: ["ci_waiting"],
  ci_waiting: ["implementing", "merged"],
  merged: ["deploying"],
  deploying: ["deployed", "rolled_back"],
  deployed: [],
  rolled_back: [],
  failed: [],
};
const TERMINAL: readonly JobStatus[] = ["deployed", "rolled_back", "failed"];

function expected(from: JobStatus, to: JobStatus): boolean {
  if (to === "failed") return !TERMINAL.includes(from);
  return EXPECTED[from].includes(to);
}

function insertJob(db: ReturnType<typeof migratedMemoryDb>["db"], status: JobStatus) {
  return db
    .insert(jobs)
    .values({
      repo: "octo-org/demo",
      issue_number: 7,
      trigger_comment_id: Math.floor(Math.random() * 1e9),
      requested_by: "octo-requester",
      instruction: "直して",
      status,
      created_at: 1,
      updated_at: 1,
    })
    .returning()
    .get();
}

describe("canTransition", () => {
  const pairs = JOB_STATUSES.flatMap((from) => JOB_STATUSES.map((to) => [from, to] as const));
  test.each(pairs)("%s → %s が表どおり", (from, to) => {
    expect(canTransition(from, to)).toBe(expected(from, to));
  });

  test("表は全状態を持つ", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
  });
});

describe("transition", () => {
  test("状態を変え、state_changed を1件残す", () => {
    const { db, close } = migratedMemoryDb();
    const job = insertJob(db, "planning");
    const updated = transition(db, job.id, "planning", "implementing", 100, { round: 1 });
    expect(updated).toMatchObject({ status: "implementing", updated_at: 100, finished_at: null });
    const events = db.select().from(jobEvents).where(eq(jobEvents.job_id, job.id)).all();
    expect(events).toEqual([
      expect.objectContaining({
        type: "state_changed",
        from_status: "planning",
        to_status: "implementing",
        detail: JSON.stringify({ round: 1 }),
        created_at: 100,
      }),
    ]);
    close();
  });

  test("detail を省くと NULL", () => {
    const { db, close } = migratedMemoryDb();
    const job = insertJob(db, "queued");
    transition(db, job.id, "queued", "planning", 5);
    const [event] = db.select().from(jobEvents).all();
    expect(event?.detail).toBeNull();
    close();
  });

  test("failed に移すと finished_at と、渡した failure_reason が入る", () => {
    const { db, close } = migratedMemoryDb();
    const job = insertJob(db, "testing");
    const updated = transition(db, job.id, "testing", "failed", 200, undefined, {
      failure_reason: "timeout: 時間切れ",
    });
    expect(updated).toMatchObject({
      status: "failed",
      finished_at: 200,
      failure_reason: "timeout: 時間切れ",
    });
    close();
  });

  test("表にない遷移は StateTransitionError で、状態も記録も変わらない", () => {
    const { db, close } = migratedMemoryDb();
    const job = insertJob(db, "queued");
    expect(() => transition(db, job.id, "queued", "judging", 10)).toThrow(StateTransitionError);
    expect(db.select().from(jobs).get()?.status).toBe("queued");
    expect(db.select().from(jobEvents).all()).toEqual([]);
    close();
  });

  test("同じ状態への遷移も表にないので拒否する", () => {
    const { db, close } = migratedMemoryDb();
    const job = insertJob(db, "implementing");
    expect(() => transition(db, job.id, "implementing", "implementing", 10)).toThrow(
      StateTransitionError,
    );
    close();
  });

  test("現在の状態が from でなければ StateTransitionError で、何も変わらない", () => {
    const { db, close } = migratedMemoryDb();
    const job = insertJob(db, "testing");
    expect(() => transition(db, job.id, "planning", "implementing", 10)).toThrow(
      StateTransitionError,
    );
    expect(db.select().from(jobs).get()?.status).toBe("testing");
    expect(db.select().from(jobEvents).all()).toEqual([]);
    close();
  });

  test("ないジョブは StateTransitionError", () => {
    const { db, close } = migratedMemoryDb();
    expect(() => transition(db, 999, "queued", "planning", 10)).toThrow(StateTransitionError);
    close();
  });
});
