import { chmodSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { type FakeResponse, TEST_NOW, type TestConfigOverrides } from "../llm/testing.ts";
import { agentRuns, llmCalls } from "../queue/schema.ts";
import type { Plan } from "./plan.ts";
import { type PipelineInput, type PipelinePhase, runPipeline } from "./run.ts";
import {
  createFakeDiffSource,
  createFakeWorkspace,
  createPipelineTestEnv,
  type FakeBashBehavior,
  textResponse,
  toolCallResponse,
} from "./testing.ts";
import type { Verdict } from "./verify.ts";

const HOUR = 3_600_000;
const INITIAL = { "src/a.ts": "export const a = 1;\n" };

const PLAN: Plan = {
  summary: "a を 2 にする",
  steps: ["src/a.ts を書き換える"],
  acceptance_criteria: ["a が 2"],
  work_type: "bugfix",
};
const PASS: Verdict = { verdict: "pass", reasons: "満たしている", criteria: [] };
const FAIL: Verdict = {
  verdict: "fail",
  reasons: "テストがない",
  criteria: [{ criterion: "a が 2", met: false }],
  fixes: ["テストを足す"],
};

const plan = (): FakeResponse => ({ text: JSON.stringify(PLAN) });
const verdict = (v: Verdict): FakeResponse => ({ text: JSON.stringify(v) });
const write = (content = "export const a = 2;\n") =>
  toolCallResponse("write_file", { path: "src/a.ts", content });
const done = (text = "終わりました") => textResponse(text);

const envs: ReturnType<typeof createPipelineTestEnv>[] = [];
afterEach(() => {
  for (const env of envs.splice(0)) {
    try {
      chmodSync(env.traceDir, 0o755);
    } catch {}
    env.cleanup();
  }
});

function setup(
  responses: FakeResponse[],
  options: {
    config?: Omit<TestConfigOverrides, "storage">;
    exec?: (command: string) => FakeBashBehavior;
    sandboxDown?: boolean;
    realTime?: boolean;
    onHang?: () => void;
  } = {},
) {
  const env = createPipelineTestEnv(
    responses,
    { ...options.config, limits: { judge_retries: 2, ...options.config?.limits } },
    options.onHang ? { onHang: options.onHang } : {},
  );
  envs.push(env);
  const workspace = createFakeWorkspace(
    { ...INITIAL },
    {
      config: env.gate.deps.config,
      agentsMd: "テストは pnpm run check",
      ...(options.exec ? { exec: options.exec } : {}),
      ...(options.sandboxDown ? { sandboxDown: true } : {}),
    },
  );
  const phases: [PipelinePhase, number][] = [];
  const now = options.realTime ? Date.now : () => TEST_NOW;
  const input: PipelineInput = {
    jobId: env.jobId,
    workspace,
    workdir: "/fake/workdir",
    issue: { title: "a を直す", body: "a を 2 にしてください" },
    deadline: now() + HOUR,
    onPhase: (phase, round) => phases.push([phase, round]),
  };
  const deps = {
    gate: env.gate.deps,
    now,
    diff: createFakeDiffSource(workspace, INITIAL),
    listFiles: async () => ["src/a.ts", "package.json"],
  };
  const models = () => env.gate.fake.requests.map((r) => r.model);
  return { env, workspace, input, deps, phases, models };
}

describe("runPipeline（US4）", () => {
  test("計画 → 実装 → テスト成功 → 判定合格で passed", async () => {
    const t = setup([plan(), write(), done(), verdict(PASS)]);
    const result = await runPipeline(t.deps, t.input);
    expect(result).toMatchObject({
      outcome: "passed",
      plan: PLAN,
      verdict: PASS,
      retries: 0,
      diffStat: { files: 1 },
      reason: "満たしている",
    });
    expect(result.diff).toContain("+export const a = 2;");
    expect(result.planText).toContain("## 受け入れ条件");
    expect(t.phases).toEqual([
      ["planning", 0],
      ["implementing", 1],
      ["testing", 1],
      ["judging", 1],
    ]);
    expect(t.models()).toEqual(["plan-model", "impl-model", "impl-model", "verify-model"]);
    expect(t.workspace.execs.map((e) => e.command)).toEqual(["pnpm run check"]);
    expect(result.rounds[0]).toMatchObject({
      checks: { status: "passed", runs: 1, fedBack: 0 },
      verdict: "pass",
    });
  });

  test("テストが1回失敗 → 差し込み → 2回目で成功して判定", async () => {
    let calls = 0;
    const t = setup([plan(), write(), done(), done("直しました"), verdict(PASS)], {
      exec: () => (++calls === 1 ? { exitCode: 1, output: "1 failed" } : {}),
    });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("passed");
    expect(t.phases.map(([p]) => p)).toEqual([
      "planning",
      "implementing",
      "testing",
      "implementing",
      "testing",
      "judging",
    ]);
    expect(JSON.stringify(t.env.gate.fake.requests[3]?.messages)).toContain("1 failed");
    expect(result.rounds[0]?.checks).toEqual({ status: "passed", runs: 2, fedBack: 1 });
  });

  test("テストがずっと失敗 → 差し込みは上限まで、検査役を呼ばずに checks_failed", async () => {
    const t = setup([plan(), write(), done(), done(), done()], {
      config: { limits: { judge_retries: 0 }, pipeline: { max_check_feedbacks: 2 } },
      exec: () => ({ exitCode: 1, output: "FAIL" }),
    });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("rejected");
    expect(result.rounds[0]).toMatchObject({
      reason: "checks_failed",
      verdict: "not_judged",
      checks: { status: "failed", runs: 3, fedBack: 2 },
    });
    expect(t.models()).not.toContain("verify-model");
    expect(result.reason).toContain("工程内テストが通りませんでした");
  });

  test("1回目の判定が不合格 → 2回目の実装に理由と diff が渡り、合格", async () => {
    const t = setup([
      plan(),
      write(),
      done(),
      verdict(FAIL),
      done("テストも足しました"),
      verdict(PASS),
    ]);
    const result = await runPipeline(t.deps, t.input);
    expect(result).toMatchObject({ outcome: "passed", retries: 1 });
    const secondImplement = JSON.stringify(t.env.gate.fake.requests[4]?.messages);
    expect(secondImplement).toContain("テストがない");
    expect(secondImplement).toContain("テストを足す");
    expect(secondImplement).toContain("+export const a = 2;");
    expect(t.phases.filter(([p]) => p === "implementing").map(([, r]) => r)).toEqual([1, 2]);
  });

  test("ずっと不合格 → judge_retries + 1 回で rejected、最後の理由", async () => {
    const t = setup([plan(), write(), done(), verdict(FAIL), done(), verdict(FAIL)], {
      config: { limits: { judge_retries: 1 } },
    });
    const result = await runPipeline(t.deps, t.input);
    expect(result).toMatchObject({ outcome: "rejected", retries: 1 });
    expect(result.rounds).toHaveLength(2);
    expect(result.reason).toContain("テストがない");
    expect(
      t.env.gate.db
        .select()
        .from(agentRuns)
        .all()
        .filter((r) => r.phase === "implement"),
    ).toHaveLength(2);
  });

  test("lastJudge: 最後に検査役へ渡した回・diff・テスト結果（012）", async () => {
    const t = setup([plan(), write(), done(), verdict(FAIL), done("直しました"), verdict(PASS)]);
    const result = await runPipeline(t.deps, t.input);
    expect(result.lastJudge?.round).toBe(2);
    expect(result.lastJudge?.diff).toBe(result.diff);
    expect(result.lastJudge?.checks).not.toBe("");
    // 検査役に渡したテスト結果の要約と同じ文字列
    expect(JSON.stringify(t.env.gate.fake.requests.at(-1)?.messages)).toContain(
      JSON.stringify(result.lastJudge?.checks).slice(1, 20),
    );
  });

  test("lastJudge: 判定まで進まなければ undefined", async () => {
    const t = setup([plan(), write(), done(), done()], {
      config: { limits: { judge_retries: 0 }, pipeline: { max_check_feedbacks: 1 } },
      exec: () => ({ exitCode: 1, output: "FAIL" }),
    });
    const result = await runPipeline(t.deps, t.input);
    expect(result.lastJudge).toBeUndefined();
  });

  test("lastJudge: 1回目は判定・2回目はテスト失敗 → round 1 のまま", async () => {
    let calls = 0;
    const t = setup([plan(), write(), done(), verdict(FAIL), done(), done()], {
      config: { limits: { judge_retries: 1 }, pipeline: { max_check_feedbacks: 1 } },
      exec: () => (++calls === 1 ? {} : { exitCode: 1, output: "FAIL" }),
    });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("rejected");
    expect(result.rounds[1]?.reason).toBe("checks_failed");
    expect(result.lastJudge?.round).toBe(1);
  });

  test("何も変えずに完了 → 検査役を呼ばずに no_changes", async () => {
    const t = setup([plan(), done()], { config: { limits: { judge_retries: 0 } } });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("rejected");
    expect(result.rounds[0]?.reason).toBe("no_changes");
    expect(t.models()).not.toContain("verify-model");
  });

  test("実装工程が max_turns → 判定せずにやり直し", async () => {
    const t = setup(
      [plan(), toolCallResponse("read_file", { path: "src/a.ts" }), write(), done(), verdict(PASS)],
      { config: { limits: { judge_retries: 1, max_turns_per_phase: 1 } } },
    );
    const result = await runPipeline(t.deps, t.input);
    expect(result.rounds[0]?.reason).toBe("max_turns");
    expect(result.rounds[0]?.verdict).toBe("not_judged");
  });

  test("実装工程が failed（作業場の異常）→ やり直さず failed", async () => {
    const read = () => toolCallResponse("read_file", { path: "src/a.ts" });
    const t = setup([plan(), read(), read(), read(), read()], { sandboxDown: true });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("failed");
    expect(result.rounds).toHaveLength(1);
    expect(result.error).toContain("作業場");
  });

  test("計画が2回とも壊れる → failed、実装工程を呼ばない", async () => {
    const t = setup([{ text: "計画" }, { text: "{}" }]);
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("計画を得られません");
    expect(t.models()).toEqual(["plan-model", "plan-model"]);
    expect(result.rounds).toHaveLength(0);
  });

  test("判定が2回とも壊れる → failed", async () => {
    const t = setup([plan(), write(), done(), { text: "合格" }, { text: "{}" }]);
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("判定できません");
  });

  test("ジョブの予算が途中で尽きる → budget_exceeded", async () => {
    const t = setup([plan(), write(), done(), verdict(PASS)], {
      config: { budget: { per_job_requests: 2 } },
    });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("budget_exceeded");
    expect(t.env.gate.fake.requests).toHaveLength(2);
  });

  test("期限 → timeout。テストのコマンドの signal が中止され、そのあと何も呼ばない", async () => {
    const t = setup([plan(), write(), done(), verdict(PASS)], {
      realTime: true,
      exec: () => ({ waitForAbort: true }),
    });
    const result = await runPipeline(t.deps, { ...t.input, deadline: Date.now() + 150 });
    expect(result.outcome).toBe("timeout");
    expect(t.workspace.execs[0]?.signal?.aborted).toBe(true);
    expect(t.env.gate.fake.requests).toHaveLength(3);
    expect(t.workspace.execs).toHaveLength(1);
  });

  test("呼び出し側の中断 → aborted", async () => {
    const controller = new AbortController();
    const t = setup([plan(), { hang: true }], { onHang: () => controller.abort() });
    const result = await runPipeline(t.deps, { ...t.input, signal: controller.signal });
    expect(result.outcome).toBe("aborted");
    expect(t.env.gate.fake.requests).toHaveLength(2);
  });

  test("検査役と実装役が同じモデル → LLM を呼ばずに failed", async () => {
    const t = setup([plan()], { config: { models: { verifier: "impl-model" } } });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("原則 III");
    expect(t.env.gate.fake.requests).toHaveLength(0);
  });

  test("Issue と依頼が空 → LLM を呼ばずに failed", async () => {
    const t = setup([plan()]);
    const result = await runPipeline(t.deps, { ...t.input, issue: { title: " ", body: "" } });
    expect(result.outcome).toBe("failed");
    expect(t.env.gate.fake.requests).toHaveLength(0);
  });

  test("計画を渡すと計画役を呼ばない", async () => {
    const t = setup([write(), done(), verdict(PASS)]);
    const result = await runPipeline(t.deps, { ...t.input, plan: "手書きの計画" });
    expect(result.outcome).toBe("passed");
    expect(result.plan).toBeUndefined();
    expect(result.planText).toBe("手書きの計画");
    expect(t.models()).not.toContain("plan-model");
    expect(t.phases[0]).toEqual(["implementing", 1]);
  });

  test("llm_calls の件数 = 結果の requests = 軌跡の assistant の応答の件数", async () => {
    const t = setup([plan(), write(), done(), verdict(FAIL), done(), verdict(PASS)]);
    const result = await runPipeline(t.deps, t.input);
    const calls = t.env.gate.db.select().from(llmCalls).all().length;
    const assistants = t.env
      .trace()
      .filter(
        (r) => r.type === "message" && (r.message as { role?: string }).role === "assistant",
      ).length;
    expect(result.requests).toBe(calls);
    expect(assistants).toBe(calls);
    expect(calls).toBe(6);
  });

  test("Issue とテストのログの秘密情報は、軌跡と結果に平文で残らない", async () => {
    const token = `ghp_${"c".repeat(36)}`;
    let calls = 0;
    const t = setup([plan(), write(), done(), done(), verdict(PASS)], {
      exec: () => (++calls === 1 ? { exitCode: 1, output: `leak ${token}` } : {}),
    });
    const result = await runPipeline(t.deps, {
      ...t.input,
      issue: { title: "a", body: `トークン ${token} を使って` },
    });
    expect(result.outcome).toBe("passed");
    expect(readFileSync(t.env.tracePath, "utf8")).not.toContain(token);
    expect(JSON.stringify(t.env.gate.db.select().from(agentRuns).all())).not.toContain(token);
    expect(result.reason).not.toContain(token);
  });

  test("軌跡に工程全体の行が並び、round_end が各回の結果と合う", async () => {
    const t = setup([plan(), write(), done(), verdict(FAIL), done(), verdict(PASS)]);
    await runPipeline(t.deps, t.input);
    const pipeline = t.env.trace().filter((r) => r.run === 0);
    const types = pipeline.map((r) => r.type);
    expect(types[0]).toBe("pipeline_start");
    expect(types.at(-1)).toBe("pipeline_end");
    expect(types).toContain("check_run");
    const ends = pipeline.filter((r) => r.type === "round_end");
    expect(
      ends.map((r) => r.type === "round_end" && [r.round, r.verdict, r.reason, r.next]),
    ).toEqual([
      [1, "fail", "judge_failed", "retry"],
      [2, "pass", undefined, "finish"],
    ]);
  });

  test("onPhase が投げても工程は続く", async () => {
    const t = setup([plan(), write(), done(), verdict(PASS)]);
    const result = await runPipeline(t.deps, {
      ...t.input,
      onPhase: () => {
        throw new Error("boom");
      },
    });
    expect(result.outcome).toBe("passed");
  });

  test("軌跡のディレクトリに書けない → LLM を呼ばずに failed（FR-032）", async () => {
    const t = setup([plan()]);
    chmodSync(t.env.traceDir, 0o500);
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("軌跡に書けませんでした");
    expect(t.env.gate.fake.requests).toHaveLength(0);
  });

  test("テストのコマンドが終了コード 127 → 判定せずに failed（FR-016）", async () => {
    const t = setup([plan(), write(), done(), verdict(PASS)], { exec: () => ({ exitCode: 127 }) });
    const result = await runPipeline(t.deps, t.input);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("テストのコマンドを起動できません");
    expect(t.models()).not.toContain("verify-model");
  });
});
