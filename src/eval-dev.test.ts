import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryConfig } from "./config.ts";
import { runEvalCompareCli } from "./eval-compare.ts";
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_SELF_CHECK_FAILED,
  EXIT_STOPPED,
  parseEvalDevArgs,
  runEvalDevCli,
} from "./eval-dev.ts";
import { writeEvalRun } from "./evals/result.ts";
import { caseResult, createFakePrepare, evalRun, writeTestSet } from "./evals/testing.ts";
import { createLlmModels } from "./llm/provider.ts";
import { createTestGateDeps, type FakeResponse, TEST_API_KEY, TEST_NOW } from "./llm/testing.ts";
import { textResponse, toolCallResponse } from "./pipeline/testing.ts";
import { PUBLIC_DATA_NOTICE, UsageError } from "./pipeline-dev.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const PLAN = {
  summary: "a を 2 に",
  steps: ["書き換える"],
  acceptance_criteria: ["a が 2"],
  work_type: "bugfix",
};
const passing = (): FakeResponse[] => [
  { text: JSON.stringify(PLAN) },
  toolCallResponse("write_file", { path: "src/a.ts", content: "export const a = 2;\n" }),
  textResponse("終わりました"),
  { text: JSON.stringify({ verdict: "pass", reasons: "ok", criteria: [] }) },
];

const gradeExec = (command: string, ctx: { files: Map<string, string> }) =>
  command === "grade-cmd"
    ? { exitCode: (ctx.files.get("src/a.ts") ?? "").includes("a = 2") ? 0 : 1 }
    : { exitCode: 0 };

function harness(
  responses: FakeResponse[],
  options: {
    provider?: "sakura" | "google-ai-studio";
    models?: Partial<FactoryConfig["models"]>;
    cases?: { id: string; setup?: Record<string, string> }[];
    budget?: { per_job_requests?: number };
  } = {},
) {
  const set = writeTestSet(options.cases ?? [{ id: "c1" }]);
  cleanups.push(set.cleanup);
  const traceDir = tempDir("eval-dev-trace-");
  const evalDir = tempDir("eval-dev-out-");
  const setup = createTestGateDeps({
    responses,
    config: {
      storage: { trace_dir: traceDir },
      limits: { judge_retries: 0 },
      ...(options.budget ? { budget: options.budget } : {}),
    },
    onHang: () => {},
  });
  cleanups.push(setup.close);
  const config = {
    ...setup.deps.config,
    llm: { ...setup.deps.config.llm, provider: options.provider ?? "google-ai-studio" },
    models: { ...setup.deps.config.models, ...options.models },
    storage: { ...setup.deps.config.storage, eval_dir: evalDir },
  } as FactoryConfig;
  const deps = { ...setup.deps, config, models: createLlmModels(config) };
  const fake = createFakePrepare({ exec: gradeExec });
  const out: string[] = [];
  const err: string[] = [];
  let depsCreated = false;
  const io = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    loadConfig: () => config,
    createDeps: () => {
      depsCreated = true;
      return { deps, close: () => {} };
    },
    prepare: fake.prepare,
    harness: async () => ({ commit: "abc", dirty: false }),
    now: () => TEST_NOW,
  };
  const key = options.provider === "sakura" ? "SAKURA_AI_API_KEY" : "GEMINI_API_KEY";
  return {
    setDir: set.dir,
    evalDir,
    io,
    out,
    err,
    fake,
    setup,
    env: { [key]: TEST_API_KEY },
    depsCreated: () => depsCreated,
  };
}

describe("parseEvalDevArgs", () => {
  test("引数を読む", () => {
    expect(
      parseEvalDevArgs([
        "--",
        "--set",
        "x",
        "--cases",
        "a, b",
        "--repeat",
        "2",
        "--max-requests",
        "50",
        "--baseline",
        "b.json",
        "--timeout-minutes",
        "10",
        "--allow-sakura",
        "--json",
      ]),
    ).toEqual({
      set: "x",
      cases: ["a", "b"],
      repeat: 2,
      maxRequests: 50,
      baseline: "b.json",
      timeoutMinutes: 10,
      allowSakura: true,
      selfCheck: false,
      json: true,
    });
    expect(parseEvalDevArgs([])).toMatchObject({ set: "evals", repeat: 1, selfCheck: false });
  });

  test.each([
    [["--repeat", "0"]],
    [["--max-requests", "x"]],
    [["--timeout-minutes", "1.5"]],
    [["--cases", ","]],
    [["--unknown"]],
  ])("%j はエラー", (args) => {
    expect(() => parseEvalDevArgs(args)).toThrow(UsageError);
  });
});

describe("runEvalDevCli", () => {
  test("全件を実行 → 0。結果のファイルができ、表示に result: と見積もりと公開データの注意", async () => {
    const h = harness(passing());
    const code = await runEvalDevCli(["--set", h.setDir], h.env, h.io);
    expect(code).toBe(EXIT_OK);
    const files = readdirSync(h.evalDir);
    expect(files).toHaveLength(1);
    const stdout = h.out.join("");
    expect(stdout).toContain(`result: ${join(h.evalDir, files[0] as string)}`);
    expect(stdout).toContain("c1#1");
    expect(stdout).toContain("success: 1/1");
    const stderr = h.err.join("");
    expect(stderr).toContain(PUBLIC_DATA_NOTICE);
    expect(stderr).toContain("見積もり: 1 ケース × 1 回");
  });

  test("2回目は直前の実行と比べる。--json で summary と comparison", async () => {
    const h = harness([...passing(), ...passing()]);
    writeEvalRun(
      h.evalDir,
      evalRun({
        runId: "older",
        startedAt: "2026-11-01T00:00:00.000Z",
        cases: [caseResult({ caseId: "c1", status: "failed", reason: "前回" })],
      }),
    );
    const code = await runEvalDevCli(["--set", h.setDir, "--json"], h.env, h.io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(h.out.join(""));
    expect(parsed.summary.succeeded).toBe(1);
    expect(parsed.comparison.baseline.runId).toBe("older");
    expect(parsed.comparison.improvements).toEqual([{ caseId: "c1", attempt: 1 }]);
  });

  test("さくらの設定で --allow-sakura なし → 2、LLM・DB を使わない", async () => {
    const h = harness(passing(), { provider: "sakura" });
    const code = await runEvalDevCli(["--set", h.setDir], h.env, h.io);
    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("")).toContain("--allow-sakura");
    expect(h.depsCreated()).toBe(false);
    expect(h.setup.fake.requests).toHaveLength(0);
  });

  test("APIキーがない → 2", async () => {
    const h = harness(passing());
    expect(await runEvalDevCli(["--set", h.setDir], {}, h.io)).toBe(EXIT_ERROR);
    expect(h.err.join("")).toContain("GEMINI_API_KEY");
  });

  test("セットの誤り・存在しないケース → 2", async () => {
    const h = harness(passing());
    expect(await runEvalDevCli(["--set", join(h.setDir, "none")], h.env, h.io)).toBe(EXIT_ERROR);
    expect(await runEvalDevCli(["--set", h.setDir, "--cases", "zzz"], h.env, h.io)).toBe(
      EXIT_ERROR,
    );
    expect(h.err.join("")).toContain("zzz");
  });

  test("verifier_alt が implementer と同じ → 2（原則 III）", async () => {
    const h = harness(passing(), { models: { verifier_alt: "impl-model" } });
    expect(await runEvalDevCli(["--set", h.setDir], h.env, h.io)).toBe(EXIT_ERROR);
    expect(h.err.join("")).toContain("verifier_alt");
    expect(h.setup.fake.requests).toHaveLength(0);
  });

  test("途中で止まる（評価全体の上限）→ 3。結果のファイルは残る", async () => {
    const h = harness(passing(), { cases: [{ id: "a" }, { id: "b" }] });
    const code = await runEvalDevCli(["--set", h.setDir, "--max-requests", "4"], h.env, h.io);
    expect(code).toBe(EXIT_STOPPED);
    expect(readdirSync(h.evalDir)).toHaveLength(1);
    expect(h.out.join("")).toContain("stopped: max_requests");
  });

  test("--self-check は APIキーなしで動く。全部 ok → 0、NG があれば 1", async () => {
    const ok = harness([]);
    expect(await runEvalDevCli(["--set", ok.setDir, "--self-check"], {}, ok.io)).toBe(EXIT_OK);
    expect(ok.out.join("")).toContain("self-check: 1/1 ok");
    expect(ok.depsCreated()).toBe(false);

    const ng = harness([], {
      cases: [{ id: "always", setup: { "src/a.ts": "export const a = 2;\n" } }],
    });
    expect(await runEvalDevCli(["--set", ng.setDir, "--self-check"], {}, ng.io)).toBe(
      EXIT_SELF_CHECK_FAILED,
    );
    expect(ng.out.join("")).toContain("always: NG");
  });
});

describe("runEvalCompareCli", () => {
  test("2つのファイルを比べて表示 → 0。--json も出せる", () => {
    const dir = tempDir("eval-compare-");
    const a = writeEvalRun(dir, evalRun({ runId: "a", cases: [caseResult({ status: "failed" })] }));
    const b = writeEvalRun(dir, evalRun({ runId: "b" }));
    const out: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: () => {} };
    expect(runEvalCompareCli(["--", a, b], io)).toBe(0);
    expect(out.join("")).toContain("--- vs a ---");
    expect(out.join("")).toContain("improved: c1#1");
    out.length = 0;
    expect(runEvalCompareCli([a, b, "--json"], io)).toBe(0);
    expect(JSON.parse(out.join("")).improvements).toHaveLength(1);
  });

  test("引数の誤り・読めないファイル → 2（パスを含む）", () => {
    const err: string[] = [];
    const io = { stdout: () => {}, stderr: (t: string) => err.push(t) };
    expect(runEvalCompareCli(["only-one.json"], io)).toBe(2);
    const missing = join(tempDir("eval-compare-"), "missing.json");
    expect(existsSync(missing)).toBe(false);
    expect(runEvalCompareCli([missing, missing], io)).toBe(2);
    expect(err.join("")).toContain(missing);
  });
});
