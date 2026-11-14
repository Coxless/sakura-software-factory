/**
 * 回帰評価の結果のファイル（012 data-model.md 2〜3章、contracts/result-file.md）: 型・集計・書き込み・読み込み・直前の実行の検索。
 * 文字列のマスクは書く側（runner）が済ませる。ここでは形だけを扱う。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { WORK_TYPES } from "../config.ts";

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) =>
  Type.Union([schema, Type.Null()]);

export const CASE_STATUSES = ["succeeded", "failed", "error", "not_run"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
export const STOP_REASONS = ["max_requests", "budget_exceeded", "aborted"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

const DiffStatSchema = Type.Object({
  files: Type.Integer(),
  insertions: Type.Integer(),
  deletions: Type.Integer(),
});

export const GraderResultSchema = Type.Object({
  command: Type.String(),
  exitCode: Type.Integer(),
  durationMs: Type.Number(),
  timedOut: Type.Boolean(),
  /** マスク・切り詰め後 */
  output: Type.String(),
});

export const JudgementSchema = Type.Object({
  model: Type.String(),
  /** none = 判定できない（出力が2回とも壊れた・失敗・予算切れ） */
  verdict: Type.Enum(["pass", "fail", "none"]),
  error: Type.Optional(Type.String()),
  /** 検査役の一致率の分母に入るか（research R6） */
  comparable: Type.Boolean(),
  calls: Type.Integer(),
  inputTokens: Type.Integer(),
  outputTokens: Type.Integer(),
  latencyMs: Type.Number(),
});
export type Judgement = Static<typeof JudgementSchema>;

export const CaseResultSchema = Type.Object({
  caseId: Type.String(),
  caseHash: Type.String(),
  workType: Type.Enum([...WORK_TYPES]),
  attempt: Type.Integer({ minimum: 1 }),
  status: Type.Enum([...CASE_STATUSES]),
  failure: Type.Optional(Type.Enum(["pipeline", "grader"])),
  reason: Type.String(),
  jobId: Type.Optional(Type.Integer()),
  pipeline: Type.Optional(
    Type.Object({
      outcome: Type.String(),
      retries: Type.Integer(),
      rounds: Type.Integer(),
      requests: Type.Integer(),
      diffStat: DiffStatSchema,
      planWorkType: Type.Optional(Type.String()),
      tracePath: Type.String(),
    }),
  ),
  grader: Type.Optional(
    Type.Object({
      status: Type.Enum(["passed", "failed", "unavailable"]),
      results: Type.Array(GraderResultSchema),
      error: Type.Optional(Type.String()),
    }),
  ),
  verifier: Type.Optional(JudgementSchema),
  verifierAlt: Type.Optional(JudgementSchema),
  requests: Type.Integer(),
  durationMs: Type.Number(),
});
export type CaseResult = Static<typeof CaseResultSchema>;

const VerifierStatsSchema = Type.Object({
  label: Type.Enum(["verifier", "verifier_alt"]),
  model: Type.String(),
  comparable: Type.Integer(),
  correct: Type.Integer(),
  falsePass: Type.Integer(),
  falseFail: Type.Integer(),
  undecided: Type.Integer(),
  accuracy: Nullable(Type.Number()),
  avgInputTokens: Nullable(Type.Number()),
  avgOutputTokens: Nullable(Type.Number()),
  avgLatencyMs: Nullable(Type.Number()),
});
export type VerifierStats = Static<typeof VerifierStatsSchema>;

const WorkTypeStatsSchema = Type.Object({
  executed: Type.Integer(),
  succeeded: Type.Integer(),
  successRate: Nullable(Type.Number()),
});

export const SummarySchema = Type.Object({
  executed: Type.Integer(),
  succeeded: Type.Integer(),
  failed: Type.Integer(),
  errors: Type.Integer(),
  notRun: Type.Integer(),
  successRate: Nullable(Type.Number()),
  byWorkType: Type.Record(Type.String(), WorkTypeStatsSchema),
  requests: Type.Integer(),
  avgRequests: Nullable(Type.Number()),
  avgDurationMs: Nullable(Type.Number()),
  verifiers: Type.Array(VerifierStatsSchema),
});
export type Summary = Static<typeof SummarySchema>;

export const ModelsSchema = Type.Object({
  planner: Type.String(),
  implementer: Type.String(),
  verifier: Type.String(),
  verifier_alt: Type.Optional(Type.String()),
});
export type EvalModels = Static<typeof ModelsSchema>;

export const EvalRunSchema = Type.Object({
  version: Type.Literal(1),
  runId: Type.String({ minLength: 1 }),
  setName: Type.String({ minLength: 1 }),
  startedAt: Type.String(),
  finishedAt: Type.String(),
  harness: Type.Object({ commit: Type.String(), dirty: Type.Boolean() }),
  provider: Type.String(),
  models: ModelsSchema,
  options: Type.Object({
    cases: Nullable(Type.Array(Type.String())),
    repeat: Type.Integer({ minimum: 1 }),
    maxRequests: Type.Integer({ minimum: 0 }),
  }),
  stopped: Type.Optional(Type.Enum([...STOP_REASONS])),
  cases: Type.Array(CaseResultSchema),
  summary: SummarySchema,
});
export type EvalRun = Static<typeof EvalRunSchema>;

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** 実行できた（succeeded か failed） */
export function isExecuted(c: Pick<CaseResult, "status">): boolean {
  return c.status === "succeeded" || c.status === "failed";
}

/** 検査役ごとの集計（contracts/result-file.md「集計の規則」） */
export function verifierStats(
  cases: readonly CaseResult[],
  label: "verifier" | "verifier_alt",
  model: string,
): VerifierStats {
  const key = label === "verifier" ? "verifier" : "verifierAlt";
  let comparable = 0;
  let correct = 0;
  let falsePass = 0;
  let falseFail = 0;
  let undecided = 0;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  for (const c of cases) {
    const j = c[key];
    if (!j) continue;
    calls += j.calls;
    inputTokens += j.inputTokens;
    outputTokens += j.outputTokens;
    latencyMs += j.latencyMs;
    if (!j.comparable) continue;
    const truth = c.grader?.status;
    if (truth !== "passed" && truth !== "failed") continue;
    comparable += 1;
    if (j.verdict === "none") undecided += 1;
    else if (j.verdict === "pass" && truth === "passed") correct += 1;
    else if (j.verdict === "fail" && truth === "failed") correct += 1;
    else if (j.verdict === "pass") falsePass += 1;
    else falseFail += 1;
  }
  return {
    label,
    model,
    comparable,
    correct,
    falsePass,
    falseFail,
    undecided,
    accuracy: ratio(correct, comparable),
    avgInputTokens: calls === 0 ? null : inputTokens / calls,
    avgOutputTokens: calls === 0 ? null : outputTokens / calls,
    avgLatencyMs: calls === 0 ? null : latencyMs / calls,
  };
}

/** ケースの結果から集計を作る */
export function summarize(cases: readonly CaseResult[], models: EvalModels): Summary {
  const executed = cases.filter(isExecuted);
  const succeeded = executed.filter((c) => c.status === "succeeded").length;
  const byWorkType: Summary["byWorkType"] = {};
  for (const c of executed) {
    const entry = byWorkType[c.workType] ?? { executed: 0, succeeded: 0, successRate: null };
    entry.executed += 1;
    if (c.status === "succeeded") entry.succeeded += 1;
    entry.successRate = ratio(entry.succeeded, entry.executed);
    byWorkType[c.workType] = entry;
  }
  const verifiers = [verifierStats(cases, "verifier", models.verifier)];
  if (models.verifier_alt !== undefined) {
    verifiers.push(verifierStats(cases, "verifier_alt", models.verifier_alt));
  }
  return {
    executed: executed.length,
    succeeded,
    failed: executed.length - succeeded,
    errors: cases.filter((c) => c.status === "error").length,
    notRun: cases.filter((c) => c.status === "not_run").length,
    successRate: ratio(succeeded, executed.length),
    byWorkType,
    requests: cases.reduce((sum, c) => sum + c.requests, 0),
    avgRequests: average(executed.map((c) => c.requests)),
    avgDurationMs: average(executed.map((c) => c.durationMs)),
    verifiers,
  };
}

/** `YYYYMMDDTHHmmssZ-<setName>` */
export function makeRunId(at: Date, setName: string): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `${stamp}-${setName}`;
}

/** 結果のファイルを書き、そのパスを返す */
export function writeEvalRun(dir: string, run: EvalRun): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${run.runId}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

export class EvalRunFileError extends Error {}

/** 結果のファイルを読む。形が合わなければ EvalRunFileError */
export function readEvalRun(path: string): EvalRun {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EvalRunFileError(
      `結果のファイルを読めません（${path}）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Value.Check(EvalRunSchema, value)) {
    const first = [...Value.Errors(EvalRunSchema, value)][0];
    throw new EvalRunFileError(
      `結果のファイルの形が合いません（${path}）${first ? `: ${first.instancePath} ${first.message}` : ""}`,
    );
  }
  return value as EvalRun;
}

/**
 * 同じ setName で開始時刻が before より前の、最新の結果を探す。壊れたファイルは warnings に入れて飛ばす
 */
export function findBaseline(
  dir: string,
  setName: string,
  before: string,
): { found?: { path: string; run: EvalRun }; warnings: string[] } {
  const warnings: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return { warnings };
  }
  let found: { path: string; run: EvalRun } | undefined;
  for (const name of names) {
    const path = join(dir, name);
    let run: EvalRun;
    try {
      run = readEvalRun(path);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (run.setName !== setName || run.startedAt >= before) continue;
    if (!found || run.startedAt > found.run.startedAt) found = { path, run };
  }
  return { ...(found ? { found } : {}), warnings };
}
