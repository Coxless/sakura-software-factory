import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import { createTestGateDeps, type FakeResponse } from "../llm/testing.ts";
import { agentRuns, jobs, llmCalls } from "../queue/schema.ts";
import { replayCompletion } from "../trace/replay.ts";
import type { TraceRecord } from "../trace/writer.ts";
import { runOneShot } from "./oneshot.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

const Schema = Type.Object({
  answer: Type.String({ minLength: 1 }),
  verdict: Type.Optional(Type.Enum(["pass", "fail"])),
});

function setup(responses: FakeResponse[], config: { per_job_requests?: number } = {}) {
  const traceDir = mkdtempSync(join(tmpdir(), "oneshot-test-"));
  dirs.push(traceDir);
  const gate = createTestGateDeps({
    responses,
    config: {
      storage: { trace_dir: traceDir },
      ...(config.per_job_requests ? { budget: { per_job_requests: config.per_job_requests } } : {}),
    },
    onHang: () => {},
  });
  const [job] = gate.db
    .insert(jobs)
    .values({
      repo: "local:demo",
      issue_number: 0,
      trigger_comment_id: 1,
      requested_by: "dev",
      instruction: "x",
      created_at: 1,
      updated_at: 1,
    })
    .returning()
    .all();
  const jobId = job?.id as number;
  const trace = (): TraceRecord[] =>
    readFileSync(join(traceDir, `job-${jobId}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as TraceRecord);
  const request = (overrides: Partial<Parameters<typeof runOneShot>[1]> = {}) => ({
    jobId,
    phase: "plan" as const,
    role: "planner" as const,
    schema: Schema,
    systemPrompt: "SYS",
    userMessage: "質問",
    truncated: [],
    ...overrides,
  });
  return { gate, jobId, trace, request, traceDir };
}

describe("runOneShot", () => {
  test("1回で合う → ok、requests = 1、agent_runs と軌跡に記録", async () => {
    const s = setup([{ text: '答えは {"answer": "42"}' }]);
    const out = await runOneShot({ gate: s.gate.deps }, s.request());
    expect(out).toMatchObject({ kind: "ok", value: { answer: "42" }, requests: 1 });
    const [run] = s.gate.db.select().from(agentRuns).all();
    expect(run).toMatchObject({
      phase: "plan",
      attempt: 1,
      model: "plan-model",
      turns: 1,
      requests: 1,
      tool_calls: 0,
      outcome: "completed",
      verdict: null,
    });
    const types = s.trace().map((r) => r.type);
    expect(types).toEqual(["llm_request", "message", "validation", "run_end"]);
    expect(types).not.toContain("run_start");
    expect(s.gate.db.select().from(llmCalls).all()[0]).toMatchObject({
      phase: "plan",
      role: "planner",
    });
    s.gate.close();
  });

  test("1回目が壊れ2回目が合う → ok、requests = 2。2回目に前回の出力と再要求の文が入る", async () => {
    const s = setup([{ text: '{"answer": ""}' }, { text: '{"answer": "ok"}' }]);
    const out = await runOneShot({ gate: s.gate.deps }, s.request());
    expect(out).toMatchObject({ kind: "ok", requests: 2 });
    const second = s.gate.fake.requests[1]?.messages as { role: string; content: unknown }[];
    const texts = second.map((m) => `${m.role}:${JSON.stringify(m.content)}`);
    expect(
      texts.some((t) => t.startsWith("assistant:") && t.includes('\\"answer\\": \\"\\"')),
    ).toBe(true);
    expect(texts.at(-1)).toContain("/answer");
    const runId = out.runId;
    const replayed = replayCompletion(s.trace(), runId);
    expect(replayed).toHaveLength(2);
    expect(replayed[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    s.gate.close();
  });

  test("2回とも壊れる → invalid、3回目を呼ばない", async () => {
    const s = setup([{ text: "JSON なし" }, { text: '{"answer": 1}' }, { text: '{"answer":"x"}' }]);
    const out = await runOneShot({ gate: s.gate.deps }, s.request());
    expect(out.kind).toBe("invalid");
    expect(s.gate.fake.requests).toHaveLength(2);
    expect(s.gate.db.select().from(agentRuns).all()[0]).toMatchObject({
      outcome: "failed",
      turns: 2,
      requests: 2,
    });
    s.gate.close();
  });

  test("予算切れ・中断・期限・LLM の失敗", async () => {
    const budget = setup([{ text: "{}" }, { text: "{}" }], { per_job_requests: 1 });
    expect((await runOneShot({ gate: budget.gate.deps }, budget.request())).kind).toBe(
      "budget_exceeded",
    );
    budget.gate.close();

    const controller = new AbortController();
    const aborted = setup([{ hang: true }]);
    const pending = runOneShot(
      { gate: aborted.gate.deps },
      aborted.request({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    expect((await pending).kind).toBe("aborted");
    aborted.gate.close();

    const timeoutController = new AbortController();
    const timeout = setup([{ hang: true }]);
    const pendingTimeout = runOneShot(
      { gate: timeout.gate.deps },
      timeout.request({ signal: timeoutController.signal, abortReason: () => "timeout" }),
    );
    setTimeout(() => timeoutController.abort(), 10);
    expect((await pendingTimeout).kind).toBe("timeout");
    expect(timeout.gate.db.select().from(agentRuns).all()[0]?.outcome).toBe("timeout");
    timeout.gate.close();

    const failed = setup([{ httpError: 400 }]);
    const out = await runOneShot({ gate: failed.gate.deps }, failed.request());
    expect(out.kind).toBe("failed");
    failed.gate.close();
  });

  test("判定のときは verdictOf の値を agent_runs.verdict に書く", async () => {
    const s = setup([{ text: '{"answer": "x", "verdict": "fail"}' }]);
    await runOneShot(
      { gate: s.gate.deps },
      s.request({
        phase: "judge",
        role: "verifier",
        verdictOf: (value) => (value as { verdict?: "pass" | "fail" }).verdict,
      }),
    );
    expect(s.gate.db.select().from(agentRuns).all()[0]).toMatchObject({
      phase: "judge",
      model: "verify-model",
      verdict: "fail",
    });
    s.gate.close();
  });

  test("秘密情報らしい文字列は軌跡で伏せ字になる", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const s = setup([{ text: `{"answer": "${token}"}` }]);
    await runOneShot({ gate: s.gate.deps }, s.request({ userMessage: `トークン ${token}` }));
    const raw = readFileSync(join(s.traceDir, `job-${s.jobId}.jsonl`), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain("[REDACTED]");
    s.gate.close();
  });

  test("軌跡に書けないと LLM を呼ばずに failed", async () => {
    const s = setup([{ text: '{"answer": "x"}' }]);
    chmodSync(s.traceDir, 0o500);
    const out = await runOneShot({ gate: s.gate.deps }, s.request());
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toContain("軌跡に書けませんでした");
    expect(s.gate.fake.requests).toHaveLength(0);
    s.gate.close();
  });
});
