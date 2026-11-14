import { and, eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { GitHubPort } from "../github/port.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../queue/db.ts";
import { countLlmCallsForJob } from "../queue/llm-calls.ts";
import { type Job, type JobEvent, jobEvents, jobs } from "../queue/schema.ts";
import { maskSecrets, REDACTED } from "../trace/mask.ts";
import type { DiffStat } from "./diff.ts";
import type { Plan } from "./plan.ts";
import type { PipelineResult } from "./run.ts";
import type { Condition, ConditionName } from "./ship-checks.ts";
import { isTerminal, StateTransitionError, transition } from "./state.ts";

/** 失敗の理由の分類（data-model.md。005 の結果との対応は research R2） */
export const FAILURE_KINDS = [
  "clone_failed",
  "install_failed",
  "pipeline_failed",
  "judge_rejected",
  "budget_exceeded",
  "timeout",
  "secret_detected",
  "unshippable_change",
  "ship_failed",
  "restarted",
  "stopped",
  "internal_error",
  // 009
  "ci_failed",
  "ci_timeout",
  "ci_unfixed",
  "pr_closed",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

const MAX_DETAIL_CHARS = 2000;

function describeKind(config: FactoryConfig, kind: FailureKind): string {
  switch (kind) {
    case "clone_failed":
      return "Issue またはリポジトリを取得できませんでした";
    case "install_failed":
      return "依存のインストールに失敗しました";
    case "pipeline_failed":
      return "計画から判定までの工程が失敗しました";
    case "judge_rejected":
      return `やり直しの上限（${config.limits.judge_retries} 回）まで、判定に合格しませんでした`;
    case "budget_exceeded":
      return "リクエストの予算に達しました";
    case "timeout":
      return `ジョブの時間の上限（${config.limits.job_timeout_minutes} 分）を超えました`;
    case "secret_detected":
      return "変更に秘密情報らしい値が見つかった（または確かめられなかった）ため、push していません";
    case "unshippable_change":
      return "CI の定義（`.github/workflows`）を変更したため、push していません";
    case "ship_failed":
      return "commit・push・PR の作成に失敗しました";
    case "restarted":
      return "ファクトリーの再起動で中断しました";
    case "stopped":
      return "ファクトリーの停止で中断しました";
    case "internal_error":
      return "内部エラーが起きました";
    case "ci_failed":
      return `CI 失敗後のやり直しの上限（${config.limits.ci_retries} 回）まで、CI が通りませんでした`;
    case "ci_timeout":
      return `CI の結論が ${config.limits.ci_wait_timeout_minutes} 分以内に出ませんでした`;
    case "ci_unfixed":
      return "CI の失敗を受けたやり直しで、変更がありませんでした";
    case "pr_closed":
      return "PR がマージされずに閉じられました";
  }
}

/** 止まった工程。prepare は準備（Issue・リポジトリの取得、インストール）。状態は planning のまま */
export type ReportStage = Job["status"] | "prepare";

export interface FailureReport {
  jobId: number;
  stage: ReportStage;
  kind: FailureKind;
  requests: number;
  branch: string | null;
  /** 005 の工程まで進んだときだけ */
  result?: { retries: number; diffStat: DiffStat };
  /** 説明・判定の理由など。2000 文字で切り詰める */
  detail?: string;
  /** 作業ブランチを push 済みか（008） */
  pushed?: boolean;
  /** 出荷前チェックの結果（008）。止まった条件の中身を報告に書く */
  conditions?: readonly Condition[];
  /** PR の番号と CI のやり直しの回数（009。PR のあるジョブだけ） */
  pr?: { number: number; ciRetries: number };
  /** 失敗したチェック（009。ci_failed） */
  failedChecks?: readonly FailedCheck[];
}

/** CI で失敗したチェック（009） */
export interface FailedCheck {
  name: string;
  conclusion: string;
}

const MAX_FINDINGS = 20;
const MAX_FAILED_CHECKS = 10;

/** 出荷前チェックで止まったときの説明（contracts/report.md）。秘密情報の値は書かない */
function renderShipBlock(conditions: readonly Condition[]): string[] {
  const lines: string[] = [];
  for (const condition of conditions) {
    if (condition.name === "secrets" && condition.value.status === "found") {
      const { findings } = condition.value;
      lines.push("見つかった場所（値は書きません）:");
      for (const f of findings.slice(0, MAX_FINDINGS)) {
        lines.push(`- \`${f.file}\`:${f.line}（${f.rule}）`);
      }
      if (findings.length > MAX_FINDINGS) lines.push(`- ほか ${findings.length - MAX_FINDINGS} 件`);
    } else if (condition.name === "secrets" && condition.value.status === "unavailable") {
      lines.push(`秘密情報のスキャンを実行できませんでした: ${condition.value.error}`);
    } else if (condition.name === "forbidden_paths" && condition.value.matched.length > 0) {
      lines.push("当たったパス:");
      for (const m of condition.value.matched) lines.push(`- \`${m.path}\`（\`${m.pattern}\`）`);
    }
  }
  return lines;
}

function renderFailedChecks(checks: readonly FailedCheck[]): string[] {
  const lines = checks.slice(0, MAX_FAILED_CHECKS).map((c) => `- \`${c.name}\`（${c.conclusion}）`);
  if (checks.length > MAX_FAILED_CHECKS)
    lines.push(`- ほか ${checks.length - MAX_FAILED_CHECKS} 件`);
  return lines;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** 失敗の報告の本文（contracts/report.md）。マスクは呼び出し側（failJob）で本文全体にかける */
export function renderFailureReport(config: FactoryConfig, report: FailureReport): string {
  const rows: [string, string][] = [
    ["止まった工程", report.stage === "prepare" ? "準備" : report.stage],
    ["理由", `${describeKind(config, report.kind)}（\`${report.kind}\`）`],
    ["消費したリクエスト", `${report.requests} / 1ジョブの上限 ${config.budget.per_job_requests}`],
    [
      "作業ブランチ",
      report.branch
        ? `\`${report.branch}\`（${report.pushed ? "push 済み" : "push していません"}）`
        : "なし",
    ],
  ];
  if (report.pr) {
    rows.push(["PR", `#${report.pr.number}`]);
    rows.push(["CI のやり直し", `${report.pr.ciRetries} / 上限 ${config.limits.ci_retries}`]);
  }
  if (report.result) {
    const { retries, diffStat } = report.result;
    rows.push([
      "やり直し・変更",
      `${retries} 回 / ${diffStat.files} ファイル（+${diffStat.insertions} −${diffStat.deletions}）`,
    ]);
  }
  const lines = [
    `### 🏭 ファクトリー: ジョブ #${report.jobId} は完了しませんでした`,
    "",
    "| 項目 | 内容 |",
    "|---|---|",
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
  ];
  const block =
    report.kind === "secret_detected" || report.kind === "unshippable_change"
      ? renderShipBlock(report.conditions ?? [])
      : [];
  if (block.length > 0) lines.push("", ...block);
  if (report.failedChecks && report.failedChecks.length > 0) {
    lines.push("", "失敗したチェック:", ...renderFailedChecks(report.failedChecks));
  }
  const detail = report.detail?.trim();
  if (detail) lines.push("", truncate(detail, MAX_DETAIL_CHARS));
  return lines.join("\n");
}

/** 依頼の本文が空のときの使い方（contracts/report.md） */
export function renderUsage(): string {
  return [
    "🏭 ファクトリーへの依頼は、コメントの1行目を `@agent` で始め、続けてやってほしいことを書いてください。",
    "",
    "例:",
    "@agent README のインストール手順に pnpm の場合を足してください",
  ].join("\n");
}

/** 予算切れで断ったときの知らせ（断った依頼1件ごとに1回） */
export function renderBudgetExhausted(config: FactoryConfig, remaining: number): string {
  return `🏭 今月のリクエストの予算の残り（${remaining}）が、1ジョブの上限（${config.budget.per_job_requests}）を下回っているため、この依頼は受け付けませんでした。来月（${config.budget.timezone} の月初）に改めて依頼してください。`;
}

/** 形のパターン（maskSecrets）に加え、渡した値そのもの（インストールトークンなど）を伏せる */
export function maskWith(text: string, secrets: readonly string[] = []): string {
  let masked = maskSecrets(text);
  for (const secret of secrets) {
    if (secret.length >= 4) masked = masked.split(secret).join(REDACTED);
  }
  return masked;
}

export interface ReportDeps {
  db: Db;
  config: FactoryConfig;
  logger: Logger;
  github: GitHubPort;
  now?: () => number;
}

export interface FailJobExtra {
  detail?: string;
  stage?: "prepare";
  result?: { retries: number; diffStat: DiffStat };
  /** 伏せる値（インストールトークンなど） */
  secrets?: readonly string[];
  /** 作業ブランチを push 済みか（008） */
  pushed?: boolean;
  /** 出荷前チェックの結果（008） */
  conditions?: readonly Condition[];
  /** 失敗したチェック（009） */
  failedChecks?: readonly FailedCheck[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ジョブを failed にして、Issue に1回だけ報告する（FR-025〜FR-027）。例外を投げない。
 * - 状態は DB の今の値から failed に移す（渡した job が古くてもよい）。終わりの状態なら何もしない
 * - 投稿の前に report_posted の記録を見て、二重に投稿しない
 * - 投稿に失敗したら job_events に report_failed を残す（ジョブは failed のまま）
 * - PR のあるジョブ（pr_closed 以外）は、報告のあとに PR を Draft に変えて人間に渡す（009 research R13）
 */
export async function failJob(
  deps: ReportDeps,
  job: Pick<Job, "id">,
  kind: FailureKind,
  message: string,
  extra: FailJobExtra = {},
): Promise<void> {
  const { db, logger } = deps;
  const now = deps.now ?? Date.now;
  const secrets = extra.secrets ?? [];
  const current = db.select().from(jobs).where(eq(jobs.id, job.id)).get();
  if (!current || isTerminal(current.status)) return;

  let failed: Job;
  try {
    failed = transition(
      db,
      current.id,
      current.status,
      "failed",
      now(),
      { reason: kind },
      { failure_reason: maskWith(`${kind}: ${message}`, secrets) },
    );
  } catch (error) {
    // 別の経路で先に終わった（起動時の掃除と停止が重なったなど）
    if (error instanceof StateTransitionError) {
      logger.warn({ jobId: job.id, err: error }, "ジョブを failed にできませんでした");
      return;
    }
    throw error;
  }

  const posted = db
    .select()
    .from(jobEvents)
    .where(and(eq(jobEvents.job_id, failed.id), eq(jobEvents.type, "note")))
    .all()
    .some((event) => event.detail?.includes('"kind":"report_posted"'));
  if (!posted) await postFailureReport(deps, current, failed, kind, extra);
  if (failed.pr_number !== null && kind !== "pr_closed") {
    await handOverPullRequest(deps, failed, kind, secrets);
  }
}

async function postFailureReport(
  deps: ReportDeps,
  current: Job,
  failed: Job,
  kind: FailureKind,
  extra: FailJobExtra,
): Promise<void> {
  const { db, config, logger, github } = deps;
  const now = deps.now ?? Date.now;
  const secrets = extra.secrets ?? [];

  const body = maskWith(
    renderFailureReport(config, {
      jobId: failed.id,
      stage: extra.stage ?? current.status,
      kind,
      requests: countLlmCallsForJob(db, failed.id),
      branch: failed.branch,
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
      ...(extra.pushed ? { pushed: true } : {}),
      ...(extra.conditions ? { conditions: extra.conditions } : {}),
      ...(failed.pr_number !== null
        ? { pr: { number: failed.pr_number, ciRetries: failed.ci_retries } }
        : {}),
      ...(extra.failedChecks ? { failedChecks: extra.failedChecks } : {}),
    }),
    secrets,
  );
  try {
    const url = await github.createIssueComment({
      repo: failed.repo,
      issueNumber: failed.issue_number,
      body,
    });
    db.insert(jobEvents)
      .values({
        job_id: failed.id,
        type: "note",
        detail: JSON.stringify({ kind: "report_posted", comment_url: url }),
        created_at: now(),
      })
      .run();
    logger.info({ jobId: failed.id, kind }, "失敗の報告を投稿しました");
  } catch (error) {
    const text = maskWith(errorText(error), secrets);
    db.insert(jobEvents)
      .values({
        job_id: failed.id,
        type: "error",
        detail: JSON.stringify({ kind: "report_failed", message: text }),
        created_at: now(),
      })
      .run();
    logger.error({ jobId: failed.id, kind, error: text }, "失敗の報告を投稿できませんでした");
  }
}

// ---- 008: まとめレポート（contracts/report.md） ----

const MAX_TITLE_CHARS = 72;
const MAX_REASON_DETAIL_CHARS = 2000;
const MAX_FILES_LISTED = 50;
const MAX_BODY_CHARS = 60000;

/** PR の題: 計画の概要の1行目を 72 文字で切り詰めたもの。計画がなければ `Issue #<番号> への対応` */
export function pullRequestTitle(plan: Plan | undefined, issueNumber: number): string {
  const line = plan?.summary.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return `Issue #${issueNumber} への対応`;
  const chars = Array.from(line);
  return chars.length <= MAX_TITLE_CHARS
    ? line
    : `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}…`;
}

const CONDITION_LABELS: Record<ConditionName, (config: FactoryConfig) => string> = {
  verdict: () => "検査役の判定",
  diff_size: () => "diff の大きさ",
  forbidden_paths: () => "禁止パス",
  secrets: () => "秘密情報のスキャン",
  skip_label: (config) => `\`${config.auto_merge.skip_label}\` ラベル`,
  work_type: () => "作業の種類",
};

function conditionValue(condition: Condition): string {
  switch (condition.name) {
    case "verdict":
      return condition.value === "pass" ? "合格" : "不合格";
    case "diff_size":
      return `${condition.value.lines} 行 / 上限 ${condition.value.max} 行`;
    case "forbidden_paths":
      return condition.value.matched.length === 0
        ? "なし"
        : condition.value.matched.map((m) => `\`${m.path}\`（\`${m.pattern}\`）`).join("、");
    case "secrets":
      return condition.value.status === "clean"
        ? "見つかりませんでした"
        : condition.value.status === "found"
          ? `${condition.value.findings.length} 件見つかりました`
          : "確かめられませんでした";
    case "skip_label":
      return "error" in condition.value
        ? "確かめられませんでした"
        : condition.value.present
          ? "あり"
          : "なし";
    case "work_type":
      return `${condition.value.work_type === null ? "なし" : `\`${condition.value.work_type}\``}（許可: ${condition.value.allowed.map((t) => `\`${t}\``).join(", ")}）`;
  }
}

export interface ShipReportInput {
  jobId: number;
  issueNumber: number;
  result: PipelineResult;
  requests: number;
  changes: { files: readonly { path: string }[]; insertions: number; deletions: number };
  conditions: readonly Condition[];
  unmet: readonly ConditionName[];
  decision: "auto_merge" | "draft" | "unsettled";
  notes: readonly string[];
  /** CI の欄（009）。省くと「CI の結果を待っています」 */
  ciSection?: string;
}

function decisionText(config: FactoryConfig, input: ShipReportInput): string {
  const unmetNames = input.unmet.map((name) => CONDITION_LABELS[name](config)).join("、");
  const failed = input.notes.find((n) => n.startsWith("auto_merge_failed: "));
  switch (input.decision) {
    case "auto_merge":
      return "auto-merge（squash）を有効にしました。必須チェックがすべて通ると main にマージされます";
    case "draft": {
      const parts = ["Draft PR にしました。人間の確認を待ちます。"];
      if (unmetNames) parts.push(`満たさなかった条件: ${unmetNames}。`);
      if (failed)
        parts.push(
          `auto-merge を有効にできませんでした: ${failed.slice("auto_merge_failed: ".length)}。`,
        );
      if (input.notes.includes("draft_unavailable")) {
        parts.push(
          "このリポジトリでは Draft PR を作れないため、通常の PR にしました。auto-merge は有効にしていません。",
        );
      }
      return parts.join("");
    }
    case "unsettled":
      return `auto-merge を有効にできず、Draft にも変えられませんでした。この PR は自動ではマージされない可能性があります: ${input.notes.join(" / ")}`;
  }
}

function checksText(result: PipelineResult): string {
  const last = result.rounds.at(-1);
  if (!last) return "記録なし";
  const status =
    last.checks.status === "passed"
      ? "成功"
      : last.checks.status === "failed"
        ? "失敗"
        : last.checks.status === "skipped"
          ? "コマンドが設定されていないため実行していません"
          : "実行していません";
  return `${status}（${last.checks.runs} 回実行）`;
}

/** PR の本文（まとめレポート）。マスクは呼び出し側（maskWith）で本文全体にかける */
export function renderShipReport(config: FactoryConfig, input: ShipReportInput): string {
  const { result } = input;
  const build = (reasonChars: number, filesListed: number): string => {
    const criteria = result.verdict?.criteria ?? [];
    const met = criteria.filter((c) => c.met).length;
    const lines = [
      `### 🏭 ファクトリー: ジョブ #${input.jobId} のまとめ`,
      "",
      `Refs #${input.issueNumber}`,
      "",
      `**自動マージ**: ${decisionText(config, input)}`,
      "",
      "| 条件 | 結果 | 値 |",
      "|---|---|---|",
      ...input.conditions.map(
        (c) =>
          `| ${CONDITION_LABELS[c.name](config)} | ${c.met ? "✅" : "❌"} | ${conditionValue(c)} |`,
      ),
      "",
      "#### 計画",
      result.plan?.summary ?? "（計画は渡されたもの）",
    ];
    if (result.plan) {
      lines.push(
        "",
        `作業の種類: \`${result.plan.work_type}\``,
        "",
        "受け入れ条件:",
        ...result.plan.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
      );
    }
    lines.push(
      "",
      "#### 結果",
      "| 項目 | 内容 |",
      "|---|---|",
      `| 工程内テスト | ${checksText(result)} |`,
      `| 判定 | 合格。受け入れ条件 ✅ ${met} / ${criteria.length} |`,
      `| やり直し | ${result.retries} 回 |`,
      `| 消費したリクエスト | ${input.requests} / 1ジョブの上限 ${config.budget.per_job_requests} |`,
      `| 変更 | ${input.changes.files.length} ファイル（+${input.changes.insertions} −${input.changes.deletions}） |`,
      "",
      "<details><summary>判定の理由</summary>",
      "",
      truncate(result.verdict?.reasons ?? result.reason, reasonChars),
      "",
      "</details>",
      "",
      "<details><summary>変更したファイル</summary>",
      "",
      ...input.changes.files.slice(0, filesListed).map((f) => `- \`${f.path}\``),
      ...(input.changes.files.length > filesListed
        ? [`- ほか ${input.changes.files.length - filesListed} 件`]
        : []),
      "",
      "</details>",
      "",
      input.ciSection ?? renderCiSection(config, []),
    );
    return lines.join("\n");
  };
  let body = build(MAX_REASON_DETAIL_CHARS, MAX_FILES_LISTED);
  if (body.length > MAX_BODY_CHARS) body = build(200, 10);
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
  return body;
}

/** Issue のコメント（PR を作ったとき、1回） */
export function renderShipNotice(input: {
  jobId: number;
  prUrl: string;
  decision: "auto_merge" | "draft" | "unsettled";
  unmet: readonly ConditionName[];
  requests: number;
  /** 6条件は満たしたが auto-merge を有効にできなかった */
  autoMergeFailed?: boolean;
}): string {
  const reasons = [
    ...(input.unmet.length > 0 ? [`満たさなかった条件: ${input.unmet.join(", ")}`] : []),
    ...(input.autoMergeFailed
      ? ["auto-merge を有効にできませんでした。理由は PR の本文に書きました"]
      : []),
  ];
  const decision =
    input.decision === "auto_merge"
      ? "auto-merge を予約しました"
      : input.decision === "draft"
        ? `Draft にしました${reasons.length > 0 ? `（${reasons.join("。")}）` : ""}`
        : "確定できませんでした";
  return [
    `🏭 ジョブ #${input.jobId} の変更を PR にしました: ${input.prUrl}`,
    "",
    `- 自動マージ: ${decision}`,
    `- 消費したリクエスト: ${input.requests}`,
  ].join("\n");
}

// ---- 009: PR の本文の CI の欄（contracts/report.md 1章）と、諦めたときの引き渡し（research R13） ----

export const CI_SECTION_START = "<!-- factory:ci -->";
export const CI_SECTION_END = "<!-- /factory:ci -->";
const LEGACY_CI_PLACEHOLDER = "<!-- 009・010 で CI・マージ・デプロイの結果をここに書き足す -->";
/** CI の欄に出す記録の種類 */
export const CI_EVENT_KINDS = ["ci_result", "ci_retry_pushed", "ci_gave_up", "merged"] as const;

function shortSha(sha: unknown): string {
  return typeof sha === "string" && sha !== "" ? `\`${sha.slice(0, 7)}\`` : "";
}

function decisionLabel(decision: unknown): string {
  return decision === "auto_merge"
    ? "auto-merge のまま"
    : decision === "draft"
      ? "Draft"
      : "確定できませんでした";
}

/** job_events の CI の記録から欄を作る。記録は古い順に渡す。対象の kind 以外は無視する */
export function renderCiSection(config: FactoryConfig, events: readonly JobEvent[]): string {
  const rows: string[] = [];
  for (const event of events) {
    if (event.type !== "note" || event.detail === null) continue;
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(event.detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (detail.kind) {
      case "ci_result": {
        const failed = Array.isArray(detail.failed) ? (detail.failed as FailedCheck[]) : [];
        const names = failed
          .slice(0, MAX_FAILED_CHECKS)
          .map((c) => `\`${c.name}\`（${c.conclusion}）`)
          .join("、");
        const more =
          failed.length > MAX_FAILED_CHECKS ? ` ほか ${failed.length - MAX_FAILED_CHECKS} 件` : "";
        rows.push(
          detail.conclusion === "success"
            ? `| ${String(detail.attempt ?? "")} | ${shortSha(detail.head_sha)} | ✅ 通過 | |`
            : `| ${String(detail.attempt ?? "")} | ${shortSha(detail.head_sha)} | ❌ 失敗 | ${names}${more} |`,
        );
        break;
      }
      case "ci_retry_pushed":
        rows.push(
          `| — | ${shortSha(detail.head_sha)} | 🔁 やり直しを push | CI 失敗後のやり直し ${String(detail.ci_retry)} / ${config.limits.ci_retries}。自動マージ: ${decisionLabel(detail.decision)} |`,
        );
        break;
      case "ci_gave_up": {
        const reason = typeof detail.reason === "string" ? detail.reason : "";
        const label =
          reason === "ci_timeout"
            ? `⌛ CI 待ちの時間切れ（${config.limits.ci_wait_timeout_minutes} 分）`
            : "🛑 ファクトリーは作業を止めました";
        rows.push(
          `| — | | ${label} | 理由: \`${reason}\`。${detail.converted_to_draft ? "Draft にしました。人間の確認を待ちます" : "Draft に変えられませんでした"} |`,
        );
        break;
      }
      case "merged":
        rows.push("| — | | 🎉 マージ | |");
        break;
      default:
        break;
    }
  }
  const body =
    rows.length === 0
      ? ["CI の結果を待っています"]
      : ["| # | commit | 結果 | 内容 |", "|---|---|---|---|", ...rows];
  return [CI_SECTION_START, "#### CI", ...body, CI_SECTION_END].join("\n");
}

/** 本文の CI の欄を置き換える。欄がなければ 008 の印を置き換え、それもなければ末尾に足す */
export function replaceCiSection(body: string, section: string): string {
  const start = body.indexOf(CI_SECTION_START);
  const end = body.indexOf(CI_SECTION_END);
  if (start !== -1 && end > start) {
    return `${body.slice(0, start)}${section}${body.slice(end + CI_SECTION_END.length)}`;
  }
  if (body.includes(LEGACY_CI_PLACEHOLDER)) return body.replace(LEGACY_CI_PLACEHOLDER, section);
  return body.trim() === "" ? section : `${body.replace(/\s+$/, "")}\n\n${section}`;
}

/** ジョブの CI の記録（古い順） */
export function listCiEvents(db: Db, jobId: number): JobEvent[] {
  return db
    .select()
    .from(jobEvents)
    .where(and(eq(jobEvents.job_id, jobId), eq(jobEvents.type, "note")))
    .orderBy(jobEvents.id)
    .all()
    .filter((event) => CI_EVENT_KINDS.some((kind) => event.detail?.includes(`"kind":"${kind}"`)));
}

function noteEvent(deps: ReportDeps, jobId: number, type: "note" | "error", detail: object): void {
  const now = deps.now ?? Date.now;
  deps.db
    .insert(jobEvents)
    .values({ job_id: jobId, type, detail: JSON.stringify(detail), created_at: now() })
    .run();
}

/**
 * PR の本文の CI の欄を記録から作り直して書く（research R12）。PR がない・失敗しても例外を投げず、
 * 失敗は ci_body_failed に残す
 */
export async function refreshCiSection(
  deps: ReportDeps,
  job: Pick<Job, "id" | "repo" | "pr_number">,
  secrets: readonly string[] = [],
): Promise<void> {
  if (job.pr_number === null) return;
  try {
    const pr = await deps.github.getPullRequest({ repo: job.repo, number: job.pr_number });
    const section = renderCiSection(deps.config, listCiEvents(deps.db, job.id));
    const body = maskWith(replaceCiSection(pr.body, section), secrets);
    if (body === pr.body) return;
    await deps.github.updatePullRequestBody({ repo: job.repo, number: job.pr_number, body });
  } catch (error) {
    const message = maskWith(errorText(error), secrets);
    noteEvent(deps, job.id, "error", { kind: "ci_body_failed", message });
    deps.logger.warn({ jobId: job.id, error: message }, "PR の本文の CI の欄を書けませんでした");
  }
}

/**
 * 諦めたジョブの PR を Draft に変えて人間に渡し、CI の欄に理由を書き足す（research R13）。例外を投げない。
 * 閉じた PR・すでに Draft の PR は変えない
 */
async function handOverPullRequest(
  deps: ReportDeps,
  job: Job,
  kind: FailureKind,
  secrets: readonly string[],
): Promise<void> {
  if (job.pr_number === null) return;
  let converted = false;
  try {
    const pr = await deps.github.getPullRequest({ repo: job.repo, number: job.pr_number });
    if (pr.draft) {
      converted = true;
    } else if (pr.state === "open") {
      await deps.github.convertToDraft({ repo: job.repo, nodeId: pr.nodeId });
      converted = true;
    }
  } catch (error) {
    const message = maskWith(errorText(error), secrets);
    noteEvent(deps, job.id, "error", { kind: "handover_failed", message });
    deps.logger.error({ jobId: job.id, error: message }, "PR を Draft に変えられませんでした");
  }
  noteEvent(deps, job.id, "note", {
    kind: "ci_gave_up",
    reason: kind,
    converted_to_draft: converted,
  });
  await refreshCiSection(deps, job, secrets);
}
