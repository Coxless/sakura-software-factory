import { describe, expect, test } from "vitest";
import { agentRuns, jobs } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { finishAgentRun, startAgentRun } from "./runs.ts";

function setup() {
  const handle = migratedMemoryDb();
  const [job] = handle.db
    .insert(jobs)
    .values({
      repo: "Coxless/demo",
      issue_number: 1,
      trigger_comment_id: 1,
      requested_by: "tester",
      instruction: "x",
      created_at: 1,
      updated_at: 1,
    })
    .returning()
    .all();
  return { ...handle, jobId: job?.id as number };
}

describe("agent_runs", () => {
  test("attempt は (job_id, phase) ごとに 1 から数える。outcome は NULL で始まる", () => {
    const { db, jobId, close } = setup();
    const start = (phase: string) =>
      startAgentRun(db, {
        jobId,
        phase,
        model: "impl-model",
        tracePath: `job-${jobId}.jsonl`,
        startedAt: 10,
      });
    expect(start("implement")).toEqual({ id: 1, attempt: 1 });
    expect(start("implement")).toEqual({ id: 2, attempt: 2 });
    expect(start("judge")).toEqual({ id: 3, attempt: 1 });
    const rows = db.select().from(agentRuns).all();
    expect(rows.map((r) => r.outcome)).toEqual([null, null, null]);
    expect(rows[0]).toMatchObject({
      model: "impl-model",
      trace_path: "job-1.jsonl",
      started_at: 10,
    });
    close();
  });

  test("finishAgentRun が終わり方・各回数・原因・終了時刻を書く", () => {
    const { db, jobId, close } = setup();
    const { id } = startAgentRun(db, {
      jobId,
      phase: "implement",
      model: "m",
      tracePath: "t",
      startedAt: 1,
    });
    finishAgentRun(db, id, {
      outcome: "failed",
      turns: 3,
      requests: 4,
      toolCalls: 2,
      blockedCalls: 1,
      compactions: 1,
      steers: 1,
      error: "boom",
      finishedAt: 99,
    });
    expect(db.select().from(agentRuns).all()[0]).toMatchObject({
      outcome: "failed",
      turns: 3,
      requests: 4,
      tool_calls: 2,
      blocked_calls: 1,
      compactions: 1,
      steers: 1,
      error: "boom",
      finished_at: 99,
    });
    close();
  });

  test("判定の回は verdict を書く。省くと NULL（005）", () => {
    const { db, jobId, close } = setup();
    const summary = {
      outcome: "completed" as const,
      turns: 1,
      requests: 1,
      toolCalls: 0,
      blockedCalls: 0,
      compactions: 0,
      steers: 0,
      finishedAt: 2,
    };
    const judge = startAgentRun(db, {
      jobId,
      phase: "judge",
      model: "v",
      tracePath: "t",
      startedAt: 1,
    });
    finishAgentRun(db, judge.id, { ...summary, verdict: "fail" });
    const plan = startAgentRun(db, {
      jobId,
      phase: "plan",
      model: "p",
      tracePath: "t",
      startedAt: 1,
    });
    finishAgentRun(db, plan.id, summary);
    const rows = db.select().from(agentRuns).all();
    expect(rows.map((row) => [row.phase, row.verdict])).toEqual([
      ["judge", "fail"],
      ["plan", null],
    ]);
    close();
  });
});
