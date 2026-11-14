import { afterEach, describe, expect, test } from "vitest";
import { testConfig } from "../llm/testing.ts";
import { loadEvalSet } from "./cases.ts";
import { selfCheck } from "./selfcheck.ts";
import { createFakePrepare, writeTestSet } from "./testing.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** grade-cmd は src/a.ts が「a = 2」なら通る。check-cmd は src/a.ts が「broken」でなければ通る */
const exec = (command: string, ctx: { files: Map<string, string> }) => {
  const a = ctx.files.get("src/a.ts") ?? "";
  if (command === "grade-cmd") return { exitCode: a.includes("a = 2") ? 0 : 1, output: "grade" };
  if (command === "check-cmd") return { exitCode: a.includes("broken") ? 1 : 0, output: "check" };
  return { exitCode: 127, output: "not found" };
};

describe("selfCheck", () => {
  test("何もしなければ落ち、模範解答で通る → ok。用意は2回、close も2回", async () => {
    const s = writeTestSet([{ id: "good" }]);
    cleanups.push(s.cleanup);
    const { prepare, log } = createFakePrepare({ exec });
    const results = await selfCheck(loadEvalSet(s.dir), testConfig(), prepare);
    expect(results).toEqual([{ caseId: "good", ok: true, problems: [] }]);
    expect(log.prepared).toHaveLength(2);
    expect(log.closed).toEqual(["good", "good"]);
  });

  test("何もしなくても通る・模範解答で落ちる・模範解答で工程内テストが落ちる、を見分ける", async () => {
    const s = writeTestSet([
      { id: "always-pass", setup: { "src/a.ts": "export const a = 2;\n" } },
      { id: "bad-solution", solution: { "src/a.ts": "export const a = 3;\n" } },
      { id: "broken-checks", solution: { "src/a.ts": "export const a = 2; // broken\n" } },
    ]);
    cleanups.push(s.cleanup);
    const { prepare } = createFakePrepare({ exec });
    const results = await selfCheck(loadEvalSet(s.dir), testConfig(), prepare);
    const byId = Object.fromEntries(results.map((r) => [r.caseId, r]));
    expect(byId["always-pass"]?.ok).toBe(false);
    expect(byId["always-pass"]?.problems.join()).toContain("何もしていないのに");
    expect(byId["bad-solution"]?.problems.join()).toContain("模範解答で合格条件が通りません");
    expect(byId["broken-checks"]?.problems.join()).toContain("模範解答で工程内テストが通りません");
  });

  test("用意に失敗しても例外にせず problems に入れる", async () => {
    const s = writeTestSet([{ id: "x" }]);
    cleanups.push(s.cleanup);
    const { prepare } = createFakePrepare({ exec, failFor: () => new Error("docker がない") });
    const [result] = await selfCheck(loadEvalSet(s.dir), testConfig(), prepare);
    expect(result?.ok).toBe(false);
    expect(result?.problems.join()).toContain("docker がない");
  });
});
