import { describe, expect, test } from "vitest";
import { budget, jobs, llmCalls, type NewLlmCall } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { BudgetExceededError, canAcceptNewJob, checkBudget, ensureBudgetMonth } from "./budget.ts";
import { TEST_NOW, testConfig } from "./testing.ts";

const call = (overrides: Partial<NewLlmCall> = {}): NewLlmCall => ({
  phase: "implement",
  role: "implementer",
  model: "m",
  attempt: 1,
  latency_ms: 1,
  status: "ok",
  created_at: TEST_NOW,
  ...overrides,
});

function setup() {
  const handle = migratedMemoryDb();
  const newJob = (commentId: number) =>
    handle.db
      .insert(jobs)
      .values({
        repo: "r",
        issue_number: 1,
        trigger_comment_id: commentId,
        requested_by: "u",
        instruction: "i",
        created_at: 1,
        updated_at: 1,
      })
      .returning({ id: jobs.id })
      .get().id;
  const insertCalls = (n: number, overrides: Partial<NewLlmCall> = {}) => {
    for (let i = 0; i < n; i++) handle.db.insert(llmCalls).values(call(overrides)).run();
  };
  return { ...handle, newJob, insertCalls };
}

describe("checkBudget", () => {
  test("月とジョブの消費が上限未満なら undefined", () => {
    const { db, close, newJob, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 5, per_job_requests: 3 } });
    const jobId = newJob(1);
    insertCalls(2, { job_id: jobId });
    expect(checkBudget(db, config, jobId, TEST_NOW)).toBeUndefined();
    close();
  });

  test("月の上限ちょうどで monthly の予算切れ（失敗した呼び出しも数える）", () => {
    const { db, close, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 3, per_job_requests: 3 } });
    insertCalls(2);
    insertCalls(1, { status: "error", error_kind: "transient", error: "x" });
    const exceeded = checkBudget(db, config, null, TEST_NOW);
    expect(exceeded).toBeInstanceOf(BudgetExceededError);
    expect(exceeded).toMatchObject({ scope: "monthly", limit: 3, used: 3 });
    expect(exceeded?.message).toBe("budget_exceeded:monthly limit=3 used=3");
    close();
  });

  test("ジョブの上限ちょうどで job の予算切れ。別のジョブは通る", () => {
    const { db, close, newJob, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 100, per_job_requests: 2 } });
    const jobA = newJob(1);
    const jobB = newJob(2);
    insertCalls(2, { job_id: jobA });
    expect(checkBudget(db, config, jobA, TEST_NOW)).toMatchObject({
      scope: "job",
      limit: 2,
      used: 2,
    });
    expect(checkBudget(db, config, jobB, TEST_NOW)).toBeUndefined();
    close();
  });

  test("jobId が null ならジョブの上限は見ない", () => {
    const { db, close, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 100, per_job_requests: 2 } });
    insertCalls(5);
    expect(checkBudget(db, config, null, TEST_NOW)).toBeUndefined();
    close();
  });

  test("先月の消費は数えない", () => {
    const { db, close, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 2, per_job_requests: 1 } });
    insertCalls(2, { created_at: Date.parse("2026-10-20T00:00:00Z") });
    expect(checkBudget(db, config, null, TEST_NOW)).toBeUndefined();
    close();
  });
});

describe("ensureBudgetMonth", () => {
  test("その月の行を1つだけ作り、月の上限を写す", () => {
    const { db, close } = setup();
    const config = testConfig({ budget: { monthly_requests: 1234 } });
    ensureBudgetMonth(db, config, TEST_NOW);
    ensureBudgetMonth(db, config, TEST_NOW + 1000);
    expect(db.select().from(budget).all()).toEqual([
      { month: "2026-11", monthly_limit: 1234, intake_stopped_at: null, created_at: TEST_NOW },
    ]);
    close();
  });

  test("月は設定のタイムゾーンで決める（JST の 12/1 0:00 は UTC の 11/30 15:00）", () => {
    const { db, close } = setup();
    const config = testConfig();
    ensureBudgetMonth(db, config, Date.parse("2026-11-30T15:00:00Z"));
    expect(db.select({ month: budget.month }).from(budget).all()).toEqual([{ month: "2026-12" }]);
    close();
  });
});

describe("canAcceptNewJob", () => {
  test("月の残りが1ジョブの上限以上なら受け付け、残りを返す", () => {
    const { db, close, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 10, per_job_requests: 4 } });
    insertCalls(6);
    expect(canAcceptNewJob(db, config, TEST_NOW)).toEqual({ accept: true, remaining: 4 });
    close();
  });

  test("月の残りが1ジョブの上限を下回ったら受け付けない（US2-5）", () => {
    const { db, close, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 10, per_job_requests: 4 } });
    insertCalls(7);
    expect(canAcceptNewJob(db, config, TEST_NOW)).toEqual({ accept: false, remaining: 3 });
    close();
  });

  test("月の境目: JST の月初を過ぎると新しい月の件数で数え直す（US2-6）", () => {
    const { db, close, insertCalls } = setup();
    const config = testConfig({ budget: { monthly_requests: 10, per_job_requests: 4 } });
    // 2026-11-30 23:59:59.999 JST（11月の最後）
    insertCalls(10, { created_at: Date.parse("2026-11-30T14:59:59.999Z") });
    const endOfNovember = Date.parse("2026-11-30T14:59:59.999Z");
    const startOfDecember = Date.parse("2026-11-30T15:00:00.000Z");
    expect(canAcceptNewJob(db, config, endOfNovember)).toEqual({ accept: false, remaining: 0 });
    expect(checkBudget(db, config, null, endOfNovember)?.scope).toBe("monthly");
    expect(canAcceptNewJob(db, config, startOfDecember)).toEqual({ accept: true, remaining: 10 });
    expect(checkBudget(db, config, null, startOfDecember)).toBeUndefined();
    close();
  });
});
