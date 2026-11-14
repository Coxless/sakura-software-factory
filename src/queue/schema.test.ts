import { asc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  AGENT_RUN_OUTCOMES,
  agentRuns,
  budget,
  deployments,
  jobEvents,
  jobs,
  LLM_ERROR_KINDS,
  llmCalls,
  type NewJob,
  type VERDICTS,
} from "./schema.ts";
import { migratedMemoryDb } from "./testing.ts";

const job = (overrides: Partial<NewJob> = {}): NewJob => ({
  repo: "Coxless/demo",
  issue_number: 1,
  trigger_comment_id: 100,
  requested_by: "Coxless",
  instruction: "README を直して",
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

describe("schema", () => {
  test("各テーブルに書いた値を同じ値で読み出せる", () => {
    const { db, close } = migratedMemoryDb();
    const [inserted] = db.insert(jobs).values(job()).returning().all();
    expect(inserted).toMatchObject({
      status: "queued",
      judge_retries: 0,
      ci_retries: 0,
      branch: null,
      pr_number: null,
      started_at: null,
    });
    const jobId = inserted?.id as number;

    const call = {
      job_id: jobId,
      phase: "planning",
      role: "planner" as const,
      model: "Kimi-K2.7-Code",
      attempt: 1,
      input_tokens: 1200,
      output_tokens: 300,
      latency_ms: 4500,
      status: "error" as const,
      error_kind: "timeout" as const,
      error: "timeout",
      created_at: 10,
    };
    db.insert(llmCalls).values(call).run();
    expect(db.select().from(llmCalls).all()).toEqual([{ id: 1, ...call }]);

    db.insert(deployments)
      .values({
        repo: "Coxless/demo",
        job_id: jobId,
        commit_sha: "abc",
        image_tag: "demo:abc",
        status: "running",
        created_at: 5,
      })
      .run();
    expect(db.select().from(deployments).get()).toMatchObject({
      rolled_back: false,
      rolled_back_to: null,
      finished_at: null,
    });

    db.insert(budget).values({ month: "2026-11", monthly_limit: 3000, created_at: 1 }).run();
    expect(db.select().from(budget).get()).toEqual({
      month: "2026-11",
      monthly_limit: 3000,
      intake_stopped_at: null,
      created_at: 1,
    });
    close();
  });

  test("ジョブのイベントは書いた順に読める", () => {
    const { db, close } = migratedMemoryDb();
    const jobId = db.insert(jobs).values(job()).returning({ id: jobs.id }).get().id;
    for (const [from, to] of [
      ["queued", "planning"],
      ["planning", "implementing"],
      ["implementing", "testing"],
    ] as const) {
      db.insert(jobEvents)
        .values({
          job_id: jobId,
          type: "state_changed",
          from_status: from,
          to_status: to,
          created_at: 7,
        })
        .run();
    }
    const events = db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.job_id, jobId))
      .orderBy(asc(jobEvents.id))
      .all();
    expect(events.map((event) => event.to_status)).toEqual(["planning", "implementing", "testing"]);
    close();
  });

  test("ジョブに属さない LLM 呼び出しも書ける", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(llmCalls)
      .values({
        phase: "smoke",
        role: "implementer",
        model: "m",
        attempt: 1,
        latency_ms: 1,
        status: "ok",
        created_at: 1,
      })
      .run();
    expect(db.select().from(llmCalls).get()?.job_id).toBeNull();
    close();
  });

  test("制約に反する値は書けない", () => {
    const { sqlite, db, close } = migratedMemoryDb();
    db.insert(jobs).values(job()).run();
    const insertJob = (status: string, commentId: number) =>
      sqlite
        .prepare(
          "INSERT INTO jobs (repo, issue_number, trigger_comment_id, requested_by, instruction, status, created_at, updated_at) VALUES ('r', 1, ?, 'u', 'i', ?, 1, 1)",
        )
        .run(commentId, status);
    expect(() => insertJob("done", 200)).toThrow(/CHECK/);
    expect(() => db.insert(jobs).values(job()).run()).toThrow(/UNIQUE/);

    const insertCall = (attempt: number, latency: number) =>
      sqlite
        .prepare(
          "INSERT INTO llm_calls (phase, role, model, attempt, latency_ms, status, created_at) VALUES ('p', 'planner', 'm', ?, ?, 'ok', 1)",
        )
        .run(attempt, latency);
    expect(() => insertCall(0, 1)).toThrow(/CHECK/);
    expect(() => insertCall(1, -1)).toThrow(/CHECK/);
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO llm_calls (phase, role, model, attempt, latency_ms, status, created_at) VALUES ('p', 'boss', 'm', 1, 1, 'ok', 1)",
        )
        .run(),
    ).toThrow(/CHECK/);

    const insertResult = (status: string, errorKind: string | null) =>
      sqlite
        .prepare(
          "INSERT INTO llm_calls (phase, role, model, attempt, latency_ms, status, error_kind, created_at) VALUES ('p', 'planner', 'm', 1, 1, ?, ?, 1)",
        )
        .run(status, errorKind);
    for (const kind of LLM_ERROR_KINDS) expect(() => insertResult("error", kind)).not.toThrow();
    expect(() => insertResult("ok", null)).not.toThrow();
    // 決められた以外の種類
    expect(() => insertResult("error", "budget_exceeded")).toThrow(/CHECK/);
    // status = 'ok' ⇔ error_kind IS NULL
    expect(() => insertResult("ok", "transient")).toThrow(/CHECK/);
    expect(() => insertResult("error", null)).toThrow(/CHECK/);

    expect(() =>
      db.insert(jobEvents).values({ job_id: 999, type: "note", created_at: 1 }).run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.insert(budget).values({ month: "2026-12", monthly_limit: 0, created_at: 1 }).run(),
    ).toThrow(/CHECK/);
    close();
  });

  test("agent_runs: 終わり方の CHECK、attempt >= 1、(job_id, phase, attempt) の一意", () => {
    const { db, close } = migratedMemoryDb();
    const [inserted] = db.insert(jobs).values(job()).returning().all();
    const jobId = inserted?.id as number;
    const run = (attempt: number, outcome: string | null = null, phase = "implement") =>
      db
        .insert(agentRuns)
        .values({
          job_id: jobId,
          phase,
          attempt,
          model: "Kimi-K2.7-Code",
          outcome: outcome as (typeof AGENT_RUN_OUTCOMES)[number] | null,
          trace_path: `job-${jobId}.jsonl`,
          started_at: 1,
        })
        .run();

    run(1);
    const [row] = db.select().from(agentRuns).all();
    expect(row).toMatchObject({
      outcome: null,
      turns: 0,
      requests: 0,
      tool_calls: 0,
      blocked_calls: 0,
      compactions: 0,
      steers: 0,
      error: null,
      finished_at: null,
    });
    for (const [i, outcome] of AGENT_RUN_OUTCOMES.entries()) {
      expect(() => run(i + 2, outcome)).not.toThrow();
    }
    expect(() => run(100, "done")).toThrow(/CHECK/);
    expect(() => run(0)).toThrow(/CHECK/);
    expect(() => run(1)).toThrow(/UNIQUE/);
    expect(() => run(1, null, "judge")).not.toThrow();
    close();
  });

  test("agent_runs.verdict: NULL と pass・fail だけ（005）", () => {
    const { db, close } = migratedMemoryDb();
    const [inserted] = db.insert(jobs).values(job()).returning().all();
    const jobId = inserted?.id as number;
    const run = (attempt: number, verdict: string | null) =>
      db
        .insert(agentRuns)
        .values({
          job_id: jobId,
          phase: "judge",
          attempt,
          model: "Qwen3.6",
          verdict: verdict as (typeof VERDICTS)[number] | null,
          trace_path: `job-${jobId}.jsonl`,
          started_at: 1,
        })
        .run();
    expect(() => run(1, null)).not.toThrow();
    expect(() => run(2, "pass")).not.toThrow();
    expect(() => run(3, "fail")).not.toThrow();
    expect(() => run(4, "maybe")).toThrow(/CHECK/);
    close();
  });

  test("jobs の CI の列: ci_status は NULL と pending・passed・failed だけ（009）", () => {
    const { sqlite, db, close } = migratedMemoryDb();
    const [inserted] = db
      .insert(jobs)
      .values(
        job({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          ci_status: "pending",
          ci_deadline: 10,
          ci_event_at: 5,
        }),
      )
      .returning()
      .all();
    expect(inserted).toMatchObject({ ci_status: "pending", ci_deadline: 10, ci_event_at: 5 });
    const setStatus = (value: string | null) =>
      sqlite.prepare("UPDATE jobs SET ci_status = ? WHERE id = ?").run(value, inserted?.id);
    expect(() => setStatus("passed")).not.toThrow();
    expect(() => setStatus("failed")).not.toThrow();
    expect(() => setStatus(null)).not.toThrow();
    expect(() => setStatus("success")).toThrow(/CHECK/);
    close();
  });
});

describe("deployments（010）", () => {
  const row = (overrides: Partial<typeof deployments.$inferInsert> = {}) => ({
    repo: "Coxless/demo",
    commit_sha: "a".repeat(40),
    image_tag: "app:aaaaaaaaaaaa",
    status: "queued" as const,
    created_at: 1,
    ...overrides,
  });

  test("同じリポジトリの同じ commit は2行にできない", () => {
    const { db, close } = migratedMemoryDb();
    db.insert(deployments).values(row()).run();
    expect(() => db.insert(deployments).values(row()).run()).toThrow(/UNIQUE/);
    db.insert(deployments)
      .values(row({ repo: "Coxless/other" }))
      .run();
    close();
  });

  test("failed のときだけ failed_stage を持つ", () => {
    const { db, close } = migratedMemoryDb();
    expect(() =>
      db
        .insert(deployments)
        .values(row({ status: "failed" }))
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .insert(deployments)
        .values(row({ status: "succeeded", failed_stage: "build" }))
        .run(),
    ).toThrow(/CHECK/);
    db.insert(deployments)
      .values(row({ status: "failed", failed_stage: "health" }))
      .run();
    close();
  });

  test("決められた以外の状態・段階は拒む", () => {
    const { db, close } = migratedMemoryDb();
    expect(() =>
      db
        .insert(deployments)
        .values(row({ status: "done" as "queued" }))
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .insert(deployments)
        .values(row({ status: "failed", failed_stage: "unknown" as "build" }))
        .run(),
    ).toThrow(/CHECK/);
    close();
  });

  test("ロールバックしていなければ戻し先を持たない", () => {
    const { db, close } = migratedMemoryDb();
    expect(() =>
      db
        .insert(deployments)
        .values(row({ rolled_back_to: "app:old" }))
        .run(),
    ).toThrow(/CHECK/);
    db.insert(deployments)
      .values(
        row({
          status: "failed",
          failed_stage: "health",
          rolled_back: true,
          rolled_back_to: "app:old",
          rollback_healthy: true,
        }),
      )
      .run();
    close();
  });
});
