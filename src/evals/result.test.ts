import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  EvalRunFileError,
  findBaseline,
  type Judgement,
  makeRunId,
  readEvalRun,
  summarize,
  writeEvalRun,
} from "./result.ts";
import { caseResult, evalRun } from "./testing.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-result-"));
  dirs.push(dir);
  return dir;
};

const judgement = (verdict: Judgement["verdict"], overrides: Partial<Judgement> = {}): Judgement => ({
  model: "m",
  verdict,
  comparable: true,
  calls: 1,
  inputTokens: 100,
  outputTokens: 10,
  latencyMs: 1000,
  ...overrides,
});

const MODELS = { planner: "p", implementer: "i", verifier: "v" };

describe("summarize", () => {
  test("成功率は error・not_run を除く。作業の種類ごと・平均", () => {
    const s = summarize(
      [
        caseResult({ caseId: "a", status: "succeeded", requests: 10, durationMs: 100 }),
        caseResult({ caseId: "b", status: "failed", workType: "test", requests: 30, durationMs: 300 }),
        caseResult({ caseId: "c", status: "error", requests: 5 }),
        caseResult({ caseId: "d", status: "not_run", requests: 0 }),
      ],
      MODELS,
    );
    expect(s).toMatchObject({
      executed: 2,
      succeeded: 1,
      failed: 1,
      errors: 1,
      notRun: 1,
      successRate: 0.5,
      requests: 45,
      avgRequests: 20,
      avgDurationMs: 200,
    });
    expect(s.byWorkType).toEqual({
      bugfix: { executed: 1, succeeded: 1, successRate: 1 },
      test: { executed: 1, succeeded: 0, successRate: 0 },
    });
  });

  test("実行したケースがなければ率と平均は null", () => {
    const s = summarize([caseResult({ status: "not_run" })], MODELS);
    expect(s.successRate).toBeNull();
    expect(s.avgRequests).toBeNull();
  });

  test("検査役の集計: 正解・誤合格・誤不合格・判定できない・分母", () => {
    const passed = { status: "passed" as const, results: [] };
    const failed = { status: "failed" as const, results: [] };
    const s = summarize(
      [
        caseResult({ grader: passed, verifier: judgement("pass"), verifierAlt: judgement("fail") }),
        caseResult({ grader: failed, verifier: judgement("pass"), verifierAlt: judgement("fail") }),
        caseResult({ grader: passed, verifier: judgement("fail"), verifierAlt: judgement("none") }),
        // 分母に入らない: comparable でない・隠しチェックを実行できない
        caseResult({ grader: passed, verifier: judgement("pass", { comparable: false }) }),
        caseResult({
          grader: { status: "unavailable", results: [] },
          verifier: judgement("pass", { calls: 2, inputTokens: 500 }),
        }),
      ],
      { ...MODELS, verifier_alt: "alt" },
    );
    expect(s.verifiers).toHaveLength(2);
    expect(s.verifiers[0]).toMatchObject({
      label: "verifier",
      model: "v",
      comparable: 3,
      correct: 1,
      falsePass: 1,
      falseFail: 1,
      undecided: 0,
      accuracy: 1 / 3,
    });
    // トークンは呼び出し1回あたり: (100*4 + 500) / 6
    expect(s.verifiers[0]?.avgInputTokens).toBeCloseTo(900 / 6);
    expect(s.verifiers[1]).toMatchObject({
      label: "verifier_alt",
      model: "alt",
      comparable: 3,
      correct: 1,
      falseFail: 1,
      undecided: 1,
      accuracy: 1 / 3,
    });
  });

  test("verifier_alt がなければ検査役の集計は主だけ", () => {
    expect(summarize([caseResult()], MODELS).verifiers.map((v) => v.label)).toEqual(["verifier"]);
  });
});

describe("結果のファイル", () => {
  test("makeRunId は YYYYMMDDTHHmmssZ-<set>", () => {
    expect(makeRunId(new Date("2026-11-14T01:02:03.456Z"), "evals")).toBe("20261114T010203Z-evals");
  });

  test("書いて読むと同じ", () => {
    const dir = tempDir();
    const run = evalRun();
    const path = writeEvalRun(join(dir, "nested"), run);
    expect(path).toBe(join(dir, "nested", `${run.runId}.json`));
    expect(readEvalRun(path)).toEqual(run);
  });

  test("形が合わない・JSON でない → EvalRunFileError（パスを含む）", () => {
    const dir = tempDir();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 2 }));
    expect(() => readEvalRun(bad)).toThrow(EvalRunFileError);
    expect(() => readEvalRun(bad)).toThrow(bad);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{");
    expect(() => readEvalRun(broken)).toThrow(EvalRunFileError);
  });

  test("findBaseline: 同じ setName で開始時刻が前の最新。壊れたファイル・別のセット・後の時刻は飛ばす", () => {
    const dir = tempDir();
    writeEvalRun(dir, evalRun({ runId: "a", startedAt: "2026-11-10T00:00:00.000Z" }));
    writeEvalRun(dir, evalRun({ runId: "b", startedAt: "2026-11-12T00:00:00.000Z" }));
    writeEvalRun(dir, evalRun({ runId: "c", startedAt: "2026-11-13T00:00:00.000Z", setName: "other" }));
    writeEvalRun(dir, evalRun({ runId: "d", startedAt: "2026-11-20T00:00:00.000Z" }));
    writeFileSync(join(dir, "broken.json"), "{");
    const { found, warnings } = findBaseline(dir, "evals", "2026-11-14T00:00:00.000Z");
    expect(found?.run.runId).toBe("b");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken.json");
  });

  test("findBaseline: ディレクトリがなければ見つからない", () => {
    expect(findBaseline(join(tempDir(), "none"), "evals", "2026").found).toBeUndefined();
  });
});
