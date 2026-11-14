/**
 * 評価の結果の人が読む表示（012 contracts/commands.md）。文字列はマスク済みのものを受け取る。
 */
import type { Comparison, MetricDelta } from "./compare.ts";
import type { EvalRun, VerifierStats } from "./result.ts";
import type { SelfCheckResult } from "./selfcheck.ts";

/** 4m10s・950ms の形 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

const percent = (ratio: number | null) => (ratio === null ? "-" : `${(ratio * 100).toFixed(1)}%`);
const number1 = (value: number | null) => (value === null ? "-" : value.toFixed(1));
const signed = (value: number, text: string) => (value > 0 ? `+${text}` : text);

function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function verifierLine(v: VerifierStats): string {
  return [
    v.label.padEnd(12),
    v.model,
    ` accuracy ${v.correct}/${v.comparable} (${percent(v.accuracy)})`,
    ` false pass ${v.falsePass}  false fail ${v.falseFail}  undecided ${v.undecided}`,
    ` tokens in ${number1(v.avgInputTokens)} / out ${number1(v.avgOutputTokens)}`,
    ` latency ${formatDuration(v.avgLatencyMs)}`,
  ].join(" ");
}

function metricLine(
  label: string,
  m: MetricDelta,
  format: (v: number | null) => string,
  deltaText: (d: number) => string,
) {
  return `${label}: ${format(m.before)} → ${format(m.after)}${m.delta === null ? "" : ` (${deltaText(m.delta)})`}`;
}

export function formatComparison(c: Comparison): string {
  const refs = (list: { caseId: string; attempt: number }[]) =>
    list.length === 0 ? "（なし）" : list.map((r) => `${r.caseId}#${r.attempt}`).join(", ");
  return [
    `--- vs ${c.baseline.runId} ---`,
    `common: ${c.common}`,
    [
      metricLine("success", c.metrics.successRate, percent, (d) =>
        signed(d, `${(d * 100).toFixed(1)}pt`),
      ),
      metricLine("avg requests", c.metrics.avgRequests, number1, (d) => signed(d, d.toFixed(1))),
      metricLine("avg time", c.metrics.avgDurationMs, formatDuration, (d) =>
        d < 0 ? `-${formatDuration(-d)}` : `+${formatDuration(d)}`,
      ),
    ].join("  "),
    `improved: ${refs(c.improvements)}`,
    `regressed: ${
      c.regressions.length === 0
        ? "（なし）"
        : c.regressions.map((r) => `${r.caseId}#${r.attempt} — ${oneLine(r.reason, 80)}`).join(", ")
    }`,
    ...(c.onlyInBaseline.length > 0 ? [`only in baseline: ${refs(c.onlyInBaseline)}`] : []),
    ...(c.onlyInCurrent.length > 0 ? [`only in current: ${refs(c.onlyInCurrent)}`] : []),
    ...(c.changedCases.length > 0 ? [`changed cases: ${c.changedCases.join(", ")}`] : []),
    `config: ${
      c.configDiff.length === 0
        ? "（同じ）"
        : c.configDiff.map((d) => `${d.key} ${d.before} → ${d.after}`).join("; ")
    }`,
  ].join("\n");
}

export function formatRun(
  run: EvalRun,
  options: { resultPath?: string; comparison?: Comparison } = {},
): string {
  const width = Math.max(10, ...run.cases.map((c) => `${c.caseId}#${c.attempt}`.length)) + 2;
  const caseLines = run.cases.map((c) => {
    const parts = [
      `${c.caseId}#${c.attempt}`.padEnd(width),
      c.status.padEnd(10),
      `requests=${c.requests}`,
      `time=${formatDuration(c.durationMs)}`,
    ];
    if (c.pipeline) parts.push(`retries=${c.pipeline.retries}`);
    if (c.status === "failed") {
      const label = c.failure === "pipeline" ? `pipeline:${c.pipeline?.outcome ?? ""}` : "grader";
      parts.push(`${label} — ${oneLine(c.reason)}`);
    } else if (c.status === "error" || c.status === "not_run") {
      parts.push(`— ${oneLine(c.reason)}`);
    }
    return parts.join("  ");
  });
  const s = run.summary;
  const byType = Object.entries(s.byWorkType)
    .map(([type, v]) => `${type} ${v.succeeded}/${v.executed}`)
    .join("  ");
  return [
    `set: ${run.setName}  cases: ${new Set(run.cases.map((c) => c.caseId)).size} × ${run.options.repeat}  provider: ${run.provider}  planner: ${run.models.planner}  implementer: ${run.models.implementer}  verifier: ${run.models.verifier}${run.models.verifier_alt ? `  verifier_alt: ${run.models.verifier_alt}` : ""}`,
    ...(options.resultPath ? [`result: ${options.resultPath}`] : []),
    ...(run.stopped ? [`stopped: ${run.stopped}`] : []),
    "--- cases ---",
    ...caseLines,
    "--- summary ---",
    `success: ${s.succeeded}/${s.executed} (${percent(s.successRate)})  requests: ${s.requests} (avg ${number1(s.avgRequests)})  time: avg ${formatDuration(s.avgDurationMs)}  errors: ${s.errors}  not run: ${s.notRun}`,
    `by work type: ${byType || "（なし）"}`,
    "--- verifiers ---",
    ...s.verifiers.map(verifierLine),
    ...(options.comparison ? [formatComparison(options.comparison)] : []),
    "",
  ].join("\n");
}

export function formatEstimate(input: {
  cases: number;
  repeat: number;
  maxRequests: number;
  perJob: number;
  altVerifier: boolean;
}): string {
  const worst = input.cases * input.repeat * input.perJob;
  return `見積もり: ${input.cases} ケース × ${input.repeat} 回、1ジョブの上限 ${input.perJob}（比較用の検査役${input.altVerifier ? "あり" : "なし"}）→ 最大 ${Math.min(worst, input.maxRequests)} リクエスト（評価全体の上限 ${input.maxRequests}）。1ケース 20〜50 リクエストの見込みなら ${input.cases * input.repeat * 20}〜${input.cases * input.repeat * 50}\n`;
}

export function formatSelfCheck(results: readonly SelfCheckResult[]): string {
  return [
    ...results.map((r) =>
      r.ok ? `${r.caseId}: ok` : `${r.caseId}: NG\n${r.problems.map((p) => `  - ${p}`).join("\n")}`,
    ),
    `self-check: ${results.filter((r) => r.ok).length}/${results.length} ok`,
    "",
  ].join("\n");
}
