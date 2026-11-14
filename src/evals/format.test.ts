import { describe, expect, test } from "vitest";
import { compareRuns } from "./compare.ts";
import {
  formatComparison,
  formatDuration,
  formatEstimate,
  formatRun,
  formatSelfCheck,
} from "./format.ts";
import { caseResult, evalRun } from "./testing.ts";

describe("format", () => {
  test("formatDuration", () => {
    expect(formatDuration(950)).toBe("950ms");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(250_000)).toBe("4m10s");
    expect(formatDuration(null)).toBe("-");
  });

  test("formatRun: ケース・集計・検査役・比較の行", () => {
    const before = evalRun({
      runId: "before",
      cases: [caseResult({ caseId: "a", status: "failed", failure: "grader", reason: "x" })],
    });
    const run = evalRun({
      cases: [
        caseResult({ caseId: "a", requests: 22, durationMs: 250_000 }),
        caseResult({
          caseId: "b",
          workType: "test",
          status: "failed",
          failure: "pipeline",
          reason: "不合格の理由\n2行目",
          pipeline: {
            outcome: "rejected",
            retries: 2,
            rounds: 3,
            requests: 41,
            diffStat: { files: 1, insertions: 1, deletions: 0 },
            tracePath: "/t",
          },
        }),
        caseResult({ caseId: "c", status: "not_run", reason: "評価が止まったため" }),
      ],
      stopped: "max_requests",
    });
    const text = formatRun(run, {
      resultPath: "/data/evals/x.json",
      comparison: compareRuns(before, run),
    });
    expect(text).toContain("result: /data/evals/x.json");
    expect(text).toContain("stopped: max_requests");
    expect(text).toMatch(/a#1\s+succeeded\s+requests=22\s+time=4m10s/);
    expect(text).toContain("pipeline:rejected — 不合格の理由 2行目");
    expect(text).toContain("success: 1/2 (50.0%)");
    expect(text).toContain("not run: 1");
    expect(text).toContain("by work type: bugfix 1/1  test 0/1");
    expect(text).toContain("verifier");
    expect(text).toContain("--- vs before ---");
    expect(text).toContain("improved: a#1");
  });

  test("formatComparison: 差の符号と設定の違い", () => {
    const text = formatComparison(
      compareRuns(
        evalRun({ cases: [caseResult({ status: "failed", requests: 30, durationMs: 60_000 })] }),
        evalRun({
          cases: [caseResult({ requests: 20, durationMs: 50_000 })],
          harness: { commit: "def", dirty: false },
        }),
      ),
    );
    expect(text).toContain("success: 0.0% → 100.0% (+100.0pt)");
    expect(text).toContain("avg requests: 30.0 → 20.0 (-10.0)");
    expect(text).toContain("avg time: 1m00s → 50s (-10s)");
    expect(text).toContain("config: commit abc → def");
  });

  test("formatEstimate・formatSelfCheck", () => {
    expect(
      formatEstimate({ cases: 5, repeat: 1, maxRequests: 250, perJob: 100, altVerifier: true }),
    ).toContain("最大 250 リクエスト");
    const text = formatSelfCheck([
      { caseId: "a", ok: true, problems: [] },
      { caseId: "b", ok: false, problems: ["何もしていないのに合格条件が通ります"] },
    ]);
    expect(text).toContain("a: ok");
    expect(text).toContain("b: NG\n  - 何もしていないのに");
    expect(text).toContain("self-check: 1/2 ok");
  });
});
