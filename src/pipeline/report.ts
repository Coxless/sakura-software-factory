import { and, eq } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { GitHubPort } from "../github/port.ts";
import type { Logger } from "../log.ts";
import type { Db } from "../queue/db.ts";
import { countLlmCallsForJob } from "../queue/llm-calls.ts";
import { type Job, jobEvents, jobs } from "../queue/schema.ts";
import { maskSecrets, REDACTED } from "../trace/mask.ts";
import type { DiffStat } from "./diff.ts";
import { isTerminal, StateTransitionError, transition } from "./state.ts";

/** 失敗の理由の分類（data-model.md。005 の結果との対応は research R2） */
export const FAILURE_KINDS = [
  "clone_failed",
  "install_failed",
  "pipeline_failed",
  "judge_rejected",
  "budget_exceeded",
  "timeout",
  "shipping_not_available",
  "restarted",
  "stopped",
  "internal_error",
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
    case "shipping_not_available":
      return "判定には合格しましたが、PR を作る工程はまだありません";
    case "restarted":
      return "ファクトリーの再起動で中断しました";
    case "stopped":
      return "ファクトリーの停止で中断しました";
    case "internal_error":
      return "内部エラーが起きました";
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
    ["作業ブランチ", report.branch ? `\`${report.branch}\`（push していません）` : "なし"],
  ];
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
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ジョブを failed にして、Issue に1回だけ報告する（FR-025〜FR-027）。例外を投げない。
 * - 状態は DB の今の値から failed に移す（渡した job が古くてもよい）。終わりの状態なら何もしない
 * - 投稿の前に report_posted の記録を見て、二重に投稿しない
 * - 投稿に失敗したら job_events に report_failed を残す（ジョブは failed のまま）
 */
export async function failJob(
  deps: ReportDeps,
  job: Pick<Job, "id">,
  kind: FailureKind,
  message: string,
  extra: FailJobExtra = {},
): Promise<void> {
  const { db, config, logger, github } = deps;
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
  if (posted) return;

  const body = maskWith(
    renderFailureReport(config, {
      jobId: failed.id,
      stage: extra.stage ?? current.status,
      kind,
      requests: countLlmCallsForJob(db, failed.id),
      branch: failed.branch,
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
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
