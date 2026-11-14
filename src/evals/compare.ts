/**
 * 2つの評価の比較（012 US3、data-model.md 4章、contracts/result-file.md「比較の規則」）。純粋な関数。
 */
import { type CaseResult, type EvalRun, isExecuted } from "./result.ts";

export interface MetricDelta {
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface CaseRef {
  caseId: string;
  attempt: number;
}

export interface Comparison {
  baseline: { runId: string; startedAt: string };
  current: { runId: string; startedAt: string };
  /** 両方で実行した (caseId, attempt) の数 */
  common: number;
  metrics: {
    successRate: MetricDelta;
    avgRequests: MetricDelta;
    avgDurationMs: MetricDelta;
  };
  regressions: (CaseRef & { reason: string })[];
  improvements: CaseRef[];
  onlyInBaseline: CaseRef[];
  onlyInCurrent: CaseRef[];
  /** caseHash が違うケース */
  changedCases: string[];
  configDiff: { key: string; before: string; after: string }[];
}

const keyOf = (c: CaseRef) => `${c.caseId}#${c.attempt}`;
const average = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

function delta(before: number | null, after: number | null): MetricDelta {
  return { before, after, delta: before === null || after === null ? null : after - before };
}

function metricsOf(cases: readonly CaseResult[]) {
  return {
    successRate:
      cases.length === 0
        ? null
        : cases.filter((c) => c.status === "succeeded").length / cases.length,
    avgRequests: average(cases.map((c) => c.requests)),
    avgDurationMs: average(cases.map((c) => c.durationMs)),
  };
}

export function compareRuns(baseline: EvalRun, current: EvalRun): Comparison {
  const before = new Map(baseline.cases.map((c) => [keyOf(c), c]));
  const after = new Map(current.cases.map((c) => [keyOf(c), c]));
  const commonBefore: CaseResult[] = [];
  const commonAfter: CaseResult[] = [];
  const onlyInBaseline: CaseRef[] = [];
  const onlyInCurrent: CaseRef[] = [];
  const regressions: Comparison["regressions"] = [];
  const improvements: CaseRef[] = [];
  const ref = (c: CaseResult): CaseRef => ({ caseId: c.caseId, attempt: c.attempt });

  // 「ある」= not_run 以外（実行した・実行できなかった）
  const present = (c: CaseResult | undefined): c is CaseResult =>
    c !== undefined && c.status !== "not_run";
  for (const [key, b] of before) {
    const a = after.get(key);
    if (present(b) && !present(a)) onlyInBaseline.push(ref(b));
    if (!present(a) || !present(b)) continue;
    if (isExecuted(a) && isExecuted(b)) {
      commonBefore.push(b);
      commonAfter.push(a);
    }
    const wasOk = b.status === "succeeded";
    const isOk = a.status === "succeeded";
    if (wasOk && !isOk) regressions.push({ ...ref(a), reason: a.reason });
    if (!wasOk && isOk) improvements.push(ref(a));
  }
  for (const [key, a] of after) {
    if (present(a) && !present(before.get(key))) onlyInCurrent.push(ref(a));
  }

  const hashBefore = new Map(baseline.cases.map((c) => [c.caseId, c.caseHash]));
  const changedCases = [
    ...new Set(
      current.cases
        .filter((c) => hashBefore.has(c.caseId) && hashBefore.get(c.caseId) !== c.caseHash)
        .map((c) => c.caseId),
    ),
  ];

  const configDiff: Comparison["configDiff"] = [];
  const pushDiff = (key: string, b: string | undefined, a: string | undefined) => {
    if ((b ?? "") !== (a ?? ""))
      configDiff.push({ key, before: b ?? "（なし）", after: a ?? "（なし）" });
  };
  pushDiff("provider", baseline.provider, current.provider);
  for (const key of ["planner", "implementer", "verifier", "verifier_alt"] as const) {
    pushDiff(key, baseline.models[key], current.models[key]);
  }
  pushDiff(
    "commit",
    `${baseline.harness.commit}${baseline.harness.dirty ? "（変更あり）" : ""}`,
    `${current.harness.commit}${current.harness.dirty ? "（変更あり）" : ""}`,
  );

  const mb = metricsOf(commonBefore);
  const ma = metricsOf(commonAfter);
  return {
    baseline: { runId: baseline.runId, startedAt: baseline.startedAt },
    current: { runId: current.runId, startedAt: current.startedAt },
    common: commonAfter.length,
    metrics: {
      successRate: delta(mb.successRate, ma.successRate),
      avgRequests: delta(mb.avgRequests, ma.avgRequests),
      avgDurationMs: delta(mb.avgDurationMs, ma.avgDurationMs),
    },
    regressions,
    improvements,
    onlyInBaseline,
    onlyInCurrent,
    changedCases,
    configDiff,
  };
}
