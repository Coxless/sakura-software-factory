import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createTestGateDeps,
  type FakeResponse,
  TEST_NOW,
  type TestConfigOverrides,
} from "../llm/testing.ts";
import type { Plan } from "../pipeline/plan.ts";
import type { FakeBashBehavior } from "../pipeline/testing.ts";
import { textResponse, toolCallResponse } from "../pipeline/testing.ts";
import type { Verdict } from "../pipeline/verify.ts";
import { jobs, llmCalls } from "../queue/schema.ts";
import { type EvalCase, loadEvalSet } from "./cases.ts";
import { type EvalProgress, type EvalRunInput, runEvals } from "./runner.ts";
import { createFakePrepare, type TestCaseSpec, writeTestSet } from "./testing.ts";

const PLAN: Plan = {
  summary: "a を 2 にする",
  steps: ["src/a.ts を書き換える"],
  acceptance_criteria: ["a が 2"],
  work_type: "bugfix",
};
const PASS: Verdict = { verdict: "pass", reasons: "満たしている", criteria: [] };
const FAIL: Verdict = {
  verdict: "fail",
  reasons: "足りない",
  criteria: [{ criterion: "a が 2", met: false }],
};
const plan = (): FakeResponse => ({ text: JSON.stringify(PLAN), usage: { input: 50, output: 5 } });
const verdict = (v: Verdict): FakeResponse => ({
  text: JSON.stringify(v),
  usage: { input: 300, output: 30 },
});
const write = (path = "src/a.ts", content = "export const a = 2;\n") =>
  toolCallResponse("write_file", { path, content });
const done = () => textResponse("終わりました");
/** 1ケースが合格まで進む応答（LLM 4回） */
const passing = (): FakeResponse[] => [plan(), write(), done(), verdict(PASS)];

/** grade-cmd は src/a.ts が「a = 2」なら通る。check-cmd は通る */
const defaultExec = (
  command: string,
  ctx: { evalCase: EvalCase; files: Map<string, string> },
): FakeBashBehavior => {
  if (command === "grade-cmd") {
    return { exitCode: (ctx.files.get("src/a.ts") ?? "").includes("a = 2") ? 0 : 1 };
  }
  return { exitCode: 0 };
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(
  cases: TestCaseSpec[],
  responses: FakeResponse[],
  options: {
    config?: Omit<TestConfigOverrides, "storage">;
    exec?: typeof defaultExec;
    failFor?: (c: EvalCase) => Error | undefined;
  } = {},
) {
  const s = writeTestSet(cases);
  const traceDir = mkdtempSync(join(tmpdir(), "eval-runner-"));
  cleanups.push(s.cleanup, () => rmSync(traceDir, { recursive: true, force: true }));
  const gate = createTestGateDeps({
    responses,
    config: {
      ...options.config,
      limits: { judge_retries: 0, ...options.config?.limits },
      storage: { trace_dir: traceDir },
    },
    onHang: () => {},
  });
  cleanups.push(gate.close);
  const set = loadEvalSet(s.dir);
  const fake = createFakePrepare({
    exec: options.exec ?? defaultExec,
    ...(options.failFor ? { failFor: options.failFor } : {}),
  });
  const events: EvalProgress[] = [];
  const run = (overrides: Partial<EvalRunInput> = {}) =>
    runEvals(
      {
        gate: gate.deps,
        prepare: fake.prepare,
        now: () => TEST_NOW,
        harness: async () => ({ commit: "abc123", dirty: false }),
      },
      {
        set,
        repeat: 1,
        maxRequests: 1000,
        timeoutMinutes: 60,
        cases: null,
        onProgress: (e) => events.push(e),
        ...overrides,
      },
    );
  const bodies = () => gate.fake.requests.map((r) => JSON.stringify(r.body));
  return { gate, set, fake, run, events, bodies };
}

describe("runEvals（US2）", () => {
  test("工程が合格し隠しチェックも通る → succeeded。リクエスト数は llm_calls と一致", async () => {
    const t = setup([{ id: "c1" }], passing());
    const run = await t.run();
    const [c] = run.cases;
    expect(c).toMatchObject({
      caseId: "c1",
      status: "succeeded",
      requests: 4,
      pipeline: { outcome: "passed", retries: 0, rounds: 1, planWorkType: "bugfix" },
      grader: { status: "passed" },
      verifier: { model: "verify-model", verdict: "pass", comparable: true, calls: 1 },
    });
    expect(c?.verifierAlt).toBeUndefined();
    const jobRows = t.gate.db.select().from(jobs).all();
    expect(jobRows.map((j) => j.repo)).toEqual(["eval:evals/c1"]);
    expect(t.gate.db.select().from(llmCalls).all()).toHaveLength(4);
    expect(run).toMatchObject({
      version: 1,
      setName: "evals",
      harness: { commit: "abc123", dirty: false },
      models: { planner: "plan-model", implementer: "impl-model", verifier: "verify-model" },
      summary: { executed: 1, succeeded: 1, successRate: 1, requests: 4 },
    });
    expect(run.runId).toMatch(/^\d{8}T\d{6}Z-evals$/);
    expect(run.stopped).toBeUndefined();
  });

  test("工程は合格したが隠しチェックが落ちる → failed（grader）", async () => {
    const t = setup([{ id: "c1" }], passing(), {
      exec: (cmd) => (cmd === "grade-cmd" ? { exitCode: 1, output: "1 failed" } : { exitCode: 0 }),
    });
    const [c] = (await t.run()).cases;
    expect(c).toMatchObject({ status: "failed", failure: "grader", grader: { status: "failed" } });
    expect(c?.reason).toContain("grade-cmd");
    expect(c?.verifier).toMatchObject({ verdict: "pass", comparable: true });
  });

  test("工程が不合格 → failed（pipeline）。隠しチェックは記録する", async () => {
    const t = setup([{ id: "c1" }], [plan(), write(), done(), verdict(FAIL)]);
    const run = await t.run();
    expect(run.cases[0]).toMatchObject({
      status: "failed",
      failure: "pipeline",
      pipeline: { outcome: "rejected" },
      grader: { status: "passed" },
      verifier: { verdict: "fail", comparable: true },
    });
    expect(run.summary.verifiers[0]).toMatchObject({ comparable: 1, falseFail: 1 });
  });

  test("各ケースで新しく用意し、必ず片付ける。ケースごとにジョブが分かれる", async () => {
    const t = setup([{ id: "a" }, { id: "b" }], [...passing(), ...passing()]);
    const run = await t.run();
    expect(run.cases.map((c) => c.status)).toEqual(["succeeded", "succeeded"]);
    expect(t.fake.log.closed).toEqual(["a", "b"]);
    const jobIds = t.fake.log.prepared.map((p) => p.jobId);
    expect(new Set(jobIds).size).toBe(2);
    expect(t.fake.log.prepared[1]?.workspace.files.get("src/a.ts")).toBe("export const a = 2;\n");
  });

  test("隠しのファイルは LLM の入力に現れず、隠しチェックの時点では置かれている", async () => {
    const marker = "HIDDEN_MARKER_7f3a";
    let seen = false;
    const t = setup([{ id: "c1", hidden: { ".eval/x.test.ts": marker } }], passing(), {
      exec: (cmd, ctx) => {
        if (cmd === "grade-cmd") seen = ctx.files.get(".eval/x.test.ts") === marker;
        return { exitCode: 0 };
      },
    });
    await t.run();
    expect(seen).toBe(true);
    for (const body of t.bodies()) expect(body).not.toContain(marker);
  });

  test("実装役が隠しのファイルと同じパスに書いても、隠しチェックの時点では上書きされている", async () => {
    const marker = "HIDDEN_MARKER_9b1c";
    let content: string | undefined;
    const t = setup(
      [{ id: "c1", hidden: { ".eval/x.test.ts": marker } }],
      [plan(), write(), write(".eval/x.test.ts", "AGENT"), done(), verdict(PASS)],
      {
        exec: (cmd, ctx) => {
          if (cmd === "grade-cmd") content = ctx.files.get(".eval/x.test.ts");
          return { exitCode: 0 };
        },
      },
    );
    const [c] = (await t.run()).cases;
    expect(c?.status).toBe("succeeded");
    expect(content).toBe(marker);
  });

  test("用意に失敗 → error で、次のケースへ進む", async () => {
    const t = setup([{ id: "a" }, { id: "b" }], passing(), {
      failFor: (c) => (c.id === "a" ? new Error("作業場を作れません") : undefined),
    });
    const run = await t.run();
    expect(run.cases[0]).toMatchObject({ caseId: "a", status: "error" });
    expect(run.cases[0]?.reason).toContain("作業場を作れません");
    expect(run.cases[1]).toMatchObject({ caseId: "b", status: "succeeded" });
    expect(run.summary).toMatchObject({ executed: 1, errors: 1, successRate: 1 });
  });

  test("ケースの check_commands が工程内テストとして作業場で実行される", async () => {
    const t = setup([{ id: "c1" }], passing());
    await t.run();
    const commands = t.fake.log.prepared[0]?.workspace.execs.map((e) => e.command);
    expect(commands).toEqual(["check-cmd", "grade-cmd"]);
  });

  test("隠しチェックのログの秘密情報は結果に平文で残らない", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const t = setup([{ id: "c1" }], passing(), {
      exec: (cmd) =>
        cmd === "grade-cmd" ? { exitCode: 1, output: `leaked ${token}` } : { exitCode: 0 },
    });
    const run = await t.run();
    expect(JSON.stringify(run)).not.toContain(token);
    expect(run.cases[0]?.grader?.results[0]?.output).toContain("[REDACTED]");
  });

  test("工程の中断 → 隠しチェックをせず、残りは not_run、stopped = aborted", async () => {
    const controller = new AbortController();
    const t = setup([{ id: "a" }, { id: "b" }], passing());
    const run = await t.run({
      signal: controller.signal,
      onProgress: (e) => {
        if (e.type === "phase" && e.phase === "implementing") controller.abort();
      },
    });
    expect(run.stopped).toBe("aborted");
    expect(run.cases[0]).toMatchObject({ status: "failed", pipeline: { outcome: "aborted" } });
    expect(run.cases[0]?.grader).toBeUndefined();
    expect(t.fake.log.hiddenPlaced).toEqual([]);
    expect(t.fake.log.closed).toEqual(["a"]);
    expect(run.cases[1]).toMatchObject({ caseId: "b", status: "not_run" });
    expect(run.summary.notRun).toBe(1);
  });

  test("回数を指定すると、回ごとに全ケースを回す", async () => {
    const t = setup([{ id: "a" }], [...passing(), plan(), write(), done(), verdict(FAIL)]);
    const run = await t.run({ repeat: 2 });
    expect(run.cases.map((c) => [c.caseId, c.attempt, c.status])).toEqual([
      ["a", 1, "succeeded"],
      ["a", 2, "failed"],
    ]);
    expect(run.summary.successRate).toBe(0.5);
  });

  test("src/evals と CLI は GitHub 層と出荷を import しない", () => {
    const dir = import.meta.dirname;
    const files = [
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(dir, f)),
      join(dir, "../eval-dev.ts"),
      join(dir, "../eval-compare.ts"),
    ];
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      expect(source, file).not.toMatch(/from\s+"[^"]*github\//);
      expect(source, file).not.toMatch(/from\s+"[^"]*ship[^"]*"/);
      expect(source, file).not.toMatch(/from\s+"[^"]*worker\.ts"/);
    }
  });
});

describe("runEvals: 検査役の比較（US4）", () => {
  const alt = { models: { verifier_alt: "alt-model" } };

  test("判定まで進んだケースで、同じ入力を比較用の検査役に1回渡す", async () => {
    const t = setup([{ id: "c1" }], [...passing(), verdict(FAIL)], { config: alt });
    const run = await t.run();
    const [c] = run.cases;
    expect(c).toMatchObject({
      status: "succeeded",
      verifier: { model: "verify-model", verdict: "pass" },
      verifierAlt: { model: "alt-model", verdict: "fail", comparable: true, calls: 1 },
    });
    const requests = t.gate.fake.requests;
    expect(requests.map((r) => r.model).slice(-2)).toEqual(["verify-model", "alt-model"]);
    // 主の最後の判定と比較用の判定の入力（user メッセージ）は同じ
    expect(JSON.stringify(requests.at(-1)?.messages)).toBe(
      JSON.stringify(requests.at(-2)?.messages),
    );
    const phases = t.gate.db
      .select()
      .from(llmCalls)
      .all()
      .map((r) => [r.phase, r.role]);
    expect(phases.at(-1)).toEqual(["judge_alt", "verifier"]);
    expect(run.summary.verifiers).toEqual([
      expect.objectContaining({ label: "verifier", correct: 1, comparable: 1 }),
      expect.objectContaining({ label: "verifier_alt", model: "alt-model", falseFail: 1 }),
    ]);
    expect(run.models.verifier_alt).toBe("alt-model");
  });

  test("判定まで進まないケースでは呼ばない", async () => {
    const t = setup([{ id: "c1" }], [plan(), done()], { config: alt });
    const run = await t.run();
    expect(run.cases[0]?.pipeline?.outcome).toBe("rejected");
    expect(run.cases[0]?.verifierAlt).toBeUndefined();
    expect(t.gate.fake.requests.map((r) => r.model)).not.toContain("alt-model");
  });

  test("比較用が2回とも形に合わない → verdict none、ケースの結果は変わらず、次のケースへ", async () => {
    const t = setup(
      [{ id: "a" }, { id: "b" }],
      [...passing(), { text: "わかりません" }, { text: "やはり不明" }, ...passing(), verdict(PASS)],
      { config: alt },
    );
    const run = await t.run();
    expect(run.cases[0]).toMatchObject({
      status: "succeeded",
      verifierAlt: { verdict: "none", calls: 2 },
    });
    expect(run.cases[1]).toMatchObject({ status: "succeeded", verifierAlt: { verdict: "pass" } });
    expect(run.summary.verifiers[1]).toMatchObject({ undecided: 1, correct: 1, comparable: 2 });
    const altCalls = t.gate.fake.requests.filter((r) => r.model === "alt-model");
    expect(altCalls).toHaveLength(3);
  });

  test("verifier_alt がなければ比較用の呼び出しは0件", async () => {
    const t = setup([{ id: "c1" }], passing());
    const run = await t.run();
    expect(run.summary.verifiers).toHaveLength(1);
    expect(
      t.gate.db
        .select()
        .from(llmCalls)
        .all()
        .map((r) => r.phase),
    ).not.toContain("judge_alt");
  });
});

describe("runEvals: 予算と停止（US5）", () => {
  test("評価全体の上限: 途中のケースは予算切れ、残りは not_run、消費は上限以下", async () => {
    const t = setup([{ id: "a" }, { id: "b" }, { id: "c" }], [...passing(), ...passing()]);
    const run = await t.run({ maxRequests: 6 });
    expect(run.cases.map((c) => c.status)).toEqual(["succeeded", "failed", "not_run"]);
    expect(run.cases[1]?.pipeline?.outcome).toBe("budget_exceeded");
    expect(run.stopped).toBe("max_requests");
    expect(t.gate.db.select().from(llmCalls).all().length).toBeLessThanOrEqual(6);
  });

  test("月の予算が途中で尽きる → stopped = budget_exceeded、残りは not_run", async () => {
    let consumed = false;
    const t = setup([{ id: "a" }, { id: "b" }], passing(), {
      config: { budget: { monthly_requests: 10, per_job_requests: 10 } },
      exec: (cmd) => {
        // 工程内テストの間に、ほかの呼び出しで月の枠が減ったことにする
        if (cmd === "check-cmd" && !consumed) {
          consumed = true;
          for (let i = 0; i < 8; i++) {
            t.gate.db
              .insert(llmCalls)
              .values({
                phase: "other",
                role: "planner",
                model: "x",
                attempt: 1,
                latency_ms: 1,
                status: "ok",
                created_at: TEST_NOW,
              })
              .run();
          }
        }
        return { exitCode: 0 };
      },
    });
    const run = await t.run();
    expect(run.cases[0]?.pipeline?.outcome).toBe("budget_exceeded");
    expect(run.stopped).toBe("budget_exceeded");
    expect(run.cases[1]?.status).toBe("not_run");
  });

  test("1ジョブの上限で止まったケースだけ失敗にし、評価は続ける", async () => {
    const t = setup(
      [{ id: "a" }, { id: "b" }],
      [plan(), write(), plan(), write(), done(), verdict(PASS)],
      { config: { budget: { per_job_requests: 2 } } },
    );
    const run = await t.run();
    expect(run.cases[0]?.pipeline?.outcome).toBe("budget_exceeded");
    expect(run.cases[1]?.status).not.toBe("not_run");
    expect(run.stopped).toBeUndefined();
  });

  test("月の残りが1ジョブの上限を下回っていれば、LLM を呼ばずに止める（FR-032a）", async () => {
    const t = setup([{ id: "a" }, { id: "b" }], passing(), {
      config: { budget: { monthly_requests: 50, per_job_requests: 50 } },
    });
    t.gate.db
      .insert(llmCalls)
      .values({
        phase: "other",
        role: "planner",
        model: "x",
        attempt: 1,
        latency_ms: 1,
        status: "ok",
        created_at: TEST_NOW,
      })
      .run();
    const run = await t.run();
    expect(run.cases.map((c) => c.status)).toEqual(["not_run", "not_run"]);
    expect(run.stopped).toBe("budget_exceeded");
    expect(t.gate.fake.requests).toHaveLength(0);
    expect(run.summary.executed).toBe(0);
  });

  test("始める前に中断されていれば、何も実行しない", async () => {
    const controller = new AbortController();
    controller.abort();
    const t = setup([{ id: "a" }], passing());
    const run = await t.run({ signal: controller.signal });
    expect(run.cases[0]?.status).toBe("not_run");
    expect(run.stopped).toBe("aborted");
    expect(t.fake.log.prepared).toHaveLength(0);
  });
});
