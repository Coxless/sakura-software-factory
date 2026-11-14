import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EvalSetError, loadEvalSet } from "./cases.ts";
import { DEFAULT_CASE_TOML, writeTestSet } from "./testing.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function set(...args: Parameters<typeof writeTestSet>) {
  const created = writeTestSet(...args);
  cleanups.push(created.cleanup);
  return created;
}

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof EvalSetError) return error.issues;
    throw error;
  }
  throw new Error("EvalSetError が投げられませんでした");
}

describe("loadEvalSet", () => {
  test("正しいケースが読め、既定値とハッシュが付く", () => {
    const s = set([
      { id: "b-case", issue: "B を直す\n\n本文の1行目\n本文の2行目", hidden: { ".eval/x.test.ts": "x" } },
      { id: "a-case", setup: { "src/a.ts": "bug" } },
    ]);
    const loaded = loadEvalSet(s.dir);
    expect(loaded.name).toBe("evals");
    expect(loaded.cases.map((c) => c.id)).toEqual(["a-case", "b-case"]);
    const b = loaded.cases[1];
    expect(b).toMatchObject({
      workType: "bugfix",
      title: "B を直す",
      body: "本文の1行目\n本文の2行目",
      checkCommands: ["check-cmd"],
      grader: { commands: ["grade-cmd"], timeoutSeconds: 300 },
      projectDir: join(s.dir, "projects/demo"),
    });
    expect(b?.hiddenDir).toBe(join(s.dir, "cases/b-case/hidden"));
    expect(b?.setupDir).toBeUndefined();
    expect(loaded.cases[0]?.setupDir).toBe(join(s.dir, "cases/a-case/setup"));
    expect(b?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("内容を変えるとハッシュが変わる（プロジェクトの変更も含む）", () => {
    const s = set([{ id: "c1" }]);
    const before = loadEvalSet(s.dir).cases[0]?.hash;
    writeFileSync(join(s.dir, "cases/c1/issue.md"), "別の題\n");
    const afterIssue = loadEvalSet(s.dir).cases[0]?.hash;
    writeFileSync(join(s.dir, "projects/demo/src/a.ts"), "changed");
    const afterProject = loadEvalSet(s.dir).cases[0]?.hash;
    expect(new Set([before, afterIssue, afterProject]).size).toBe(3);
  });

  test("誤りはケースの ID と理由つきで全部集める", () => {
    const s = set([
      { id: "no-grader", toml: DEFAULT_CASE_TOML.replace('commands = ["grade-cmd"]', "commands = []") },
      { id: "no-solution", solution: null },
      { id: "no-issue", issue: null },
      { id: "bad-project", toml: DEFAULT_CASE_TOML.replace("projects/demo", "projects/none") },
      { id: "unknown-key", toml: `${DEFAULT_CASE_TOML}\nextra = 1\n` },
      { id: "bad-type", toml: DEFAULT_CASE_TOML.replace("bugfix", "hotfix") },
      { id: "Bad_ID" },
    ]);
    const issues = issuesOf(() => loadEvalSet(s.dir));
    const byCase = (id: string) =>
      issues
        .filter((i) => i.caseId === id)
        .map((i) => i.message)
        .join(" / ");
    expect(byCase("no-grader")).toContain("/grader/commands");
    expect(byCase("no-solution")).toContain("solution/");
    expect(byCase("no-issue")).toContain("issue.md");
    expect(byCase("bad-project")).toContain("projects/none");
    expect(byCase("unknown-key")).toContain("/extra");
    expect(byCase("bad-type")).toContain("/work_type");
    expect(byCase("Bad_ID")).toContain("ID");
  });

  test("only で絞れる。存在しない ID は誤り", () => {
    const s = set([{ id: "a" }, { id: "b" }]);
    expect(loadEvalSet(s.dir, { only: ["b"] }).cases.map((c) => c.id)).toEqual(["b"]);
    expect(issuesOf(() => loadEvalSet(s.dir, { only: ["zzz"] }))).toEqual([
      { caseId: "zzz", message: expect.stringContaining("ありません") },
    ]);
  });

  test("cases/ がない・空 → 誤り", () => {
    const s = set([]);
    expect(issuesOf(() => loadEvalSet(s.dir))[0]?.message).toContain("1件も");
    expect(issuesOf(() => loadEvalSet(join(s.dir, "none")))[0]?.message).toContain("cases/");
  });

  test("リポジトリの evals/ は読めて、5件・作業の種類がそろっている", () => {
    const loaded = loadEvalSet(resolve(import.meta.dirname, "../../evals"));
    expect(loaded.cases).toHaveLength(5);
    expect(new Set(loaded.cases.map((c) => c.workType))).toEqual(
      new Set(["test", "bugfix", "chore", "docs", "refactor"]),
    );
    for (const c of loaded.cases) {
      expect(c.hiddenDir, c.id).toBeDefined();
      expect(c.checkCommands.length, c.id).toBeGreaterThan(0);
    }
  });
});
