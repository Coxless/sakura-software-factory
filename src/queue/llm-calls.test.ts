import { describe, expect, test } from "vitest";
import { countLlmCallsForJob, countLlmCallsInMonth } from "./llm-calls.ts";
import { jobs, llmCalls, type NewLlmCall } from "./schema.ts";
import { migratedMemoryDb } from "./testing.ts";

const at = (iso: string) => Date.parse(iso);
const call = (created_at: number, overrides: Partial<NewLlmCall> = {}): NewLlmCall => ({
  phase: "implementing",
  role: "implementer",
  model: "m",
  attempt: 1,
  latency_ms: 10,
  status: "ok",
  created_at,
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
  return { ...handle, newJob };
}

describe("countLlmCallsInMonth", () => {
  test("設定のタイムゾーンの今月分だけを数え、失敗した呼び出しも数える", () => {
    const { db, close } = setup();
    db.insert(llmCalls)
      .values([
        call(at("2026-11-30T14:59:59.999Z")), // 11月（JST）
        call(at("2026-11-30T15:00:00Z")), // 12月 1日 0:00 JST
        call(at("2026-12-10T00:00:00Z"), { status: "error", error: "x" }),
        call(at("2026-12-31T15:00:00Z")), // 1月
      ])
      .run();
    const now = at("2026-12-15T00:00:00Z");
    expect(countLlmCallsInMonth(db, now, "Asia/Tokyo")).toBe(2);
    expect(countLlmCallsInMonth(db, now, "UTC")).toBe(2);
    expect(countLlmCallsInMonth(db, at("2026-11-30T12:00:00Z"), "Asia/Tokyo")).toBe(1);
    close();
  });
});

describe("countLlmCallsForJob", () => {
  test("そのジョブの呼び出しだけを数える", () => {
    const { db, close, newJob } = setup();
    const a = newJob(1);
    const b = newJob(2);
    db.insert(llmCalls)
      .values([
        call(1, { job_id: a }),
        call(2, { job_id: a, attempt: 2 }),
        call(3, { job_id: b }),
        call(4),
      ])
      .run();
    expect(countLlmCallsForJob(db, a)).toBe(2);
    expect(countLlmCallsForJob(db, b)).toBe(1);
    close();
  });
});

test("1,000件で月とジョブの集計が1秒以内に返る", () => {
  const { db, close, newJob } = setup();
  const jobId = newJob(1);
  const base = at("2026-12-01T00:00:00Z");
  const rows = Array.from({ length: 1000 }, (_, i) =>
    call(base + i * 60_000, { job_id: i % 2 === 0 ? jobId : null }),
  );
  db.insert(llmCalls).values(rows).run();
  const started = performance.now();
  expect(countLlmCallsInMonth(db, base, "Asia/Tokyo")).toBe(1000);
  expect(countLlmCallsForJob(db, jobId)).toBe(500);
  expect(performance.now() - started).toBeLessThan(1000);
  close();
});
