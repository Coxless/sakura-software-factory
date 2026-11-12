import { afterEach, describe, expect, test } from "vitest";
import type { FakeResponse } from "../llm/testing.ts";
import { agentRuns, llmCalls } from "../queue/schema.ts";
import { createPipelineTestEnv } from "./testing.ts";
import { judge, type Verdict, verdictFeedback } from "./verify.ts";

const PASS: Verdict = {
  verdict: "pass",
  reasons: "受け入れ条件をすべて満たしている",
  criteria: [{ criterion: "a が 2", met: true }],
};
const FAIL: Verdict = {
  verdict: "fail",
  reasons: "テストを足していない",
  criteria: [{ criterion: "テストがある", met: false, note: "test/ に変更がない" }],
  fixes: ["test/a.test.ts に a が 2 のテストを足す"],
};

const envs: ReturnType<typeof createPipelineTestEnv>[] = [];
afterEach(() => {
  for (const env of envs.splice(0)) env.cleanup();
});

function env(responses: FakeResponse[], pipeline: { max_diff_chars?: number } = {}) {
  const created = createPipelineTestEnv(responses, { pipeline });
  envs.push(created);
  return created;
}

const input = (jobId: number, diff = "diff --git a/src/a.ts b/src/a.ts\n-1\n+2\n") => ({
  jobId,
  issue: { title: "a を直す", body: "a を 2 に" },
  planText: "## 受け入れ条件\n1. a が 2",
  diff,
  checks: "結果: すべて成功",
});

describe("judge（US3）", () => {
  test("合格 → ok、LLM 1回、モデルは検査役、tools なし", async () => {
    const e = env([{ text: JSON.stringify(PASS) }]);
    const out = await judge({ gate: e.gate.deps }, input(e.jobId));
    expect(out).toMatchObject({ kind: "ok", value: PASS, requests: 1 });
    expect(e.gate.fake.requests[0]?.model).toBe("verify-model");
    expect(e.gate.fake.requests[0]?.body).not.toHaveProperty("tools");
    for (const tag of ["issue", "plan", "diff", "checks"]) {
      expect(e.requestBodies()[0]).toContain(`<${tag}`);
    }
  });

  test("不合格と直すべき点", async () => {
    const e = env([{ text: `判定:\n${JSON.stringify(FAIL)}` }]);
    const out = await judge({ gate: e.gate.deps }, input(e.jobId));
    expect(out).toMatchObject({ kind: "ok", value: FAIL });
  });

  test('verdict: "maybe" → 再要求', async () => {
    const e = env([
      { text: JSON.stringify({ ...PASS, verdict: "maybe" }) },
      { text: JSON.stringify(PASS) },
    ]);
    const out = await judge({ gate: e.gate.deps }, input(e.jobId));
    expect(out).toMatchObject({ kind: "ok", requests: 2 });
  });

  test("2回とも壊れる → invalid、3回目を呼ばない", async () => {
    const e = env([{ text: "合格です" }, { text: '{"verdict":"pass"}' }, { text: "{}" }]);
    const out = await judge({ gate: e.gate.deps }, input(e.jobId));
    expect(out.kind).toBe("invalid");
    expect(e.gate.fake.requests).toHaveLength(2);
    expect(e.gate.db.select().from(agentRuns).all()[0]?.verdict).toBeNull();
  });

  test("大きな diff は切り詰め、切り詰めた旨が入る", async () => {
    const e = env([{ text: JSON.stringify(PASS) }], { max_diff_chars: 1000 });
    await judge({ gate: e.gate.deps }, input(e.jobId, `+${"x".repeat(5000)}`));
    expect(e.requestBodies()[0]).toContain('<diff truncated=\\"true\\">');
    expect(e.requestBodies()[0]).toContain("文字を省きました");
  });

  test("llm_calls に phase = judge・role = verifier、agent_runs.verdict に合否", async () => {
    const e = env([{ text: JSON.stringify(FAIL) }]);
    await judge({ gate: e.gate.deps }, input(e.jobId));
    expect(e.gate.db.select().from(llmCalls).all()[0]).toMatchObject({
      phase: "judge",
      role: "verifier",
    });
    expect(e.gate.db.select().from(agentRuns).all()[0]).toMatchObject({
      phase: "judge",
      verdict: "fail",
      outcome: "completed",
    });
  });

  test("pass で met: false の条件があっても合否は pass", async () => {
    const mixed = { ...PASS, criteria: [{ criterion: "x", met: false }] };
    const e = env([{ text: JSON.stringify(mixed) }]);
    const out = await judge({ gate: e.gate.deps }, input(e.jobId));
    expect(out.kind === "ok" && out.value.verdict).toBe("pass");
  });
});

describe("verdictFeedback", () => {
  test("理由・満たしていない条件・直すべき点", () => {
    const text = verdictFeedback(FAIL);
    expect(text).toContain("理由: テストを足していない");
    expect(text).toContain("- テストがある（test/ に変更がない）");
    expect(text).toContain("- test/a.test.ts に a が 2 のテストを足す");
  });
});
