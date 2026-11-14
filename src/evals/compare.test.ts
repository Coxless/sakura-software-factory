import { describe, expect, test } from "vitest";
import { compareRuns } from "./compare.ts";
import { caseResult, evalRun } from "./testing.ts";

describe("compareRuns（US3）", () => {
  test("共通の集合での成功率・平均リクエスト数・平均処理時間の差", () => {
    const baseline = evalRun({
      runId: "before",
      cases: [
        caseResult({ caseId: "a", status: "failed", requests: 40, durationMs: 4000 }),
        caseResult({ caseId: "b", status: "succeeded", requests: 20, durationMs: 2000 }),
      ],
    });
    const current = evalRun({
      runId: "after",
      cases: [
        caseResult({ caseId: "a", status: "succeeded", requests: 30, durationMs: 3000 }),
        caseResult({ caseId: "b", status: "succeeded", requests: 10, durationMs: 1000 }),
      ],
    });
    const c = compareRuns(baseline, current);
    expect(c.baseline.runId).toBe("before");
    expect(c.common).toBe(2);
    expect(c.metrics.successRate).toEqual({ before: 0.5, after: 1, delta: 0.5 });
    expect(c.metrics.avgRequests).toEqual({ before: 30, after: 20, delta: -10 });
    expect(c.metrics.avgDurationMs).toEqual({ before: 3000, after: 2000, delta: -1000 });
    expect(c.improvements).toEqual([{ caseId: "a", attempt: 1 }]);
    expect(c.regressions).toEqual([]);
  });

  test("後退（succeeded → failed / error）は今回の理由つき", () => {
    const c = compareRuns(
      evalRun({ cases: [caseResult({ caseId: "a" }), caseResult({ caseId: "b" })] }),
      evalRun({
        cases: [
          caseResult({ caseId: "a", status: "failed", reason: "隠しチェックが通りませんでした" }),
          caseResult({ caseId: "b", status: "error", reason: "作業場を作れません" }),
        ],
      }),
    );
    expect(c.regressions).toEqual([
      { caseId: "a", attempt: 1, reason: "隠しチェックが通りませんでした" },
      { caseId: "b", attempt: 1, reason: "作業場を作れません" },
    ]);
    // error は共通の集計に入れない
    expect(c.common).toBe(1);
  });

  test("片方にしかない・not_run は別に列挙し、集計から外す", () => {
    const c = compareRuns(
      evalRun({
        cases: [
          caseResult({ caseId: "a", requests: 10 }),
          caseResult({ caseId: "old", requests: 99 }),
          caseResult({ caseId: "skipped", status: "not_run" }),
        ],
      }),
      evalRun({
        cases: [
          caseResult({ caseId: "a", requests: 20 }),
          caseResult({ caseId: "new", requests: 99 }),
          caseResult({ caseId: "skipped" }),
          caseResult({ caseId: "old", status: "not_run" }),
        ],
      }),
    );
    expect(c.common).toBe(1);
    expect(c.metrics.avgRequests).toEqual({ before: 10, after: 20, delta: 10 });
    expect(c.onlyInBaseline).toEqual([{ caseId: "old", attempt: 1 }]);
    expect(c.onlyInCurrent.map((r) => r.caseId).sort()).toEqual(["new", "skipped"]);
    expect(c.improvements).toEqual([]);
  });

  test("ケースの内容が変わったものと、設定の違いを示す", () => {
    const c = compareRuns(
      evalRun({ cases: [caseResult({ caseHash: "sha256:1" })] }),
      evalRun({
        cases: [caseResult({ caseHash: "sha256:2" })],
        models: { planner: "p", implementer: "i2", verifier: "v", verifier_alt: "alt" },
        harness: { commit: "def", dirty: true },
      }),
    );
    expect(c.changedCases).toEqual(["c1"]);
    expect(c.configDiff).toEqual([
      { key: "implementer", before: "i", after: "i2" },
      { key: "verifier_alt", before: "（なし）", after: "alt" },
      { key: "commit", before: "abc", after: "def（変更あり）" },
    ]);
  });

  test("共通が0件でも例外にならず、指標は null", () => {
    const c = compareRuns(
      evalRun({ cases: [caseResult({ caseId: "a" })] }),
      evalRun({ cases: [caseResult({ caseId: "b" })] }),
    );
    expect(c.common).toBe(0);
    expect(c.metrics.successRate).toEqual({ before: null, after: null, delta: null });
  });
});
