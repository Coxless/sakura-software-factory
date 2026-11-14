import { sql } from "drizzle-orm";
import { FAILURE_KINDS } from "../pipeline/report.ts";
import type { Db } from "../queue/db.ts";
import { monthRange } from "../queue/month.ts";
import { TERMINAL_JOB_STATUSES } from "../queue/schema.ts";
import type { BreakdownItem, DeployRow, JobRow, Rate, RunRow, StatusSnapshot } from "./schema.ts";

/** 一覧の件数（011 research R8） */
export const RECENT_LIMITS = { jobs: 20, runs: 30, deployments: 10 } as const;

export interface CollectOptions {
  now: number;
  /** 月の区切り（[budget].timezone）。予算ゲートと同じ値を渡す */
  timeZone: string;
  /** [budget].monthly_requests */
  monthlyLimit: number;
}

const TERMINAL_LIST = sql.raw(TERMINAL_JOB_STATUSES.map((s) => `'${s}'`).join(", "));
const KNOWN_FAILURE_KINDS: ReadonlySet<string> = new Set(FAILURE_KINDS);

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, ratio: denominator === 0 ? null : numerator / denominator };
}

/** failure_reason（`<種類>: <文>`）から種類だけを取り出す。知らない種類は other（research R5） */
export function failureKind(reason: string | null): string | null {
  if (reason === null) return null;
  const kind = reason.split(":", 1)[0]?.trim() ?? "";
  return KNOWN_FAILURE_KINDS.has(kind) ? kind : "other";
}

function span(from: number | null, to: number | null): number | null {
  return from === null || to === null || to < from ? null : to - from;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** 件数の多い順、同数なら key の順 */
function breakdown(rows: { key: string | null; count: number }[]): BreakdownItem[] {
  return rows
    .map((row) => ({ key: row.key ?? "unknown", count: row.count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 状況ページの中身を記録から計算する（011 data-model.md）。読むだけで、LLM も呼ばない。
 * 出してはいけない列（依頼の本文・エラー文・軌跡の場所など）は SELECT にも入れない
 */
export function collectStatus(db: Db, options: CollectOptions): StatusSnapshot {
  const { now, timeZone, monthlyLimit } = options;
  const month = monthRange(now, timeZone);
  const { start, end } = month;

  // --- 消費（llm_calls の created_at で月を決める。予算ゲートと同じ） ---
  const inMonth = sql`created_at >= ${start} AND created_at < ${end}`;
  const totals = db.get<{
    requests: number;
    job_requests: number;
    input_tokens: number;
    output_tokens: number;
  }>(sql`
    SELECT count(*) AS requests,
           count(job_id) AS job_requests,
           coalesce(sum(input_tokens), 0) AS input_tokens,
           coalesce(sum(output_tokens), 0) AS output_tokens
      FROM llm_calls WHERE ${inMonth}`);
  const byRole = db.all<{ key: string; count: number }>(
    sql`SELECT role AS key, count(*) AS count FROM llm_calls WHERE ${inMonth} GROUP BY role`,
  );
  const byModel = db.all<{ key: string; count: number }>(
    sql`SELECT model AS key, count(*) AS count FROM llm_calls WHERE ${inMonth} GROUP BY model`,
  );
  const errorsByKind = db.all<{ key: string | null; count: number }>(sql`
    SELECT error_kind AS key, count(*) AS count FROM llm_calls
     WHERE ${inMonth} AND status = 'error' GROUP BY error_kind`);
  const budgetRow = db.get<{ intake_stopped_at: number | null }>(
    sql`SELECT intake_stopped_at FROM budget WHERE month = ${month.key}`,
  );

  // --- ジョブ（終わった時刻の月で数える。research R4） ---
  const finished = db.all<{
    status: string;
    failure_reason: string | null;
    started_at: number | null;
    finished_at: number;
  }>(sql`
    SELECT status, failure_reason, started_at, finished_at FROM jobs
     WHERE status IN (${TERMINAL_LIST})
       AND finished_at >= ${start} AND finished_at < ${end}`);
  const statusCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const durations: number[] = [];
  for (const job of finished) {
    statusCounts.set(job.status, (statusCounts.get(job.status) ?? 0) + 1);
    const kind = failureKind(job.failure_reason);
    if (kind !== null) reasonCounts.set(kind, (reasonCounts.get(kind) ?? 0) + 1);
    const duration = span(job.started_at, job.finished_at);
    if (duration !== null) durations.push(duration);
  }
  durations.sort((a, b) => a - b);
  const inProgress = db.get<{ count: number }>(
    sql`SELECT count(*) AS count FROM jobs WHERE status NOT IN (${TERMINAL_LIST})`,
  );

  // --- CI 初回通過率（009 の ci_result の1回目。ジョブごとに1件） ---
  const ci = db.get<{ denominator: number; numerator: number }>(sql`
    SELECT count(*) AS denominator, coalesce(sum(passed), 0) AS numerator FROM (
      SELECT job_id, max(json_extract(detail, '$.conclusion') = 'success') AS passed
        FROM job_events
       WHERE type = 'note'
         AND json_extract(detail, '$.kind') = 'ci_result'
         AND json_extract(detail, '$.attempt') = 1
         AND created_at >= ${start} AND created_at < ${end}
       GROUP BY job_id)`);

  // --- デプロイ ---
  const deploy = db.get<{ denominator: number; numerator: number; rolled_back: number }>(sql`
    SELECT count(*) AS denominator,
           coalesce(sum(status = 'succeeded'), 0) AS numerator,
           coalesce(sum(rolled_back), 0) AS rolled_back
      FROM deployments
     WHERE status IN ('succeeded', 'failed')
       AND finished_at >= ${start} AND finished_at < ${end}`);

  const requests = totals?.requests ?? 0;
  const jobRequests = totals?.job_requests ?? 0;
  const mean =
    durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0) / durations.length;

  return {
    generated_at: now,
    month: { key: month.key, start, end, time_zone: timeZone },
    consumption: {
      requests,
      monthly_limit: monthlyLimit,
      remaining: Math.max(0, monthlyLimit - requests),
      intake_stopped_at: budgetRow?.intake_stopped_at ?? null,
      by_role: breakdown(byRole),
      by_model: breakdown(byModel),
      job_requests: jobRequests,
      non_job_requests: requests - jobRequests,
      input_tokens: totals?.input_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
      errors_by_kind: breakdown(errorsByKind),
    },
    jobs: {
      success: rate(statusCounts.get("deployed") ?? 0, finished.length),
      by_status: breakdown([...statusCounts].map(([key, count]) => ({ key, count }))),
      failures_by_reason: breakdown([...reasonCounts].map(([key, count]) => ({ key, count }))),
      duration_ms: { count: durations.length, mean, median: median(durations) },
      in_progress: inProgress?.count ?? 0,
    },
    ci: { first_pass: rate(ci?.numerator ?? 0, ci?.denominator ?? 0) },
    deployments: {
      success: rate(deploy?.numerator ?? 0, deploy?.denominator ?? 0),
      rolled_back: deploy?.rolled_back ?? 0,
    },
    recent: {
      jobs: recentJobs(db),
      runs: recentRuns(db),
      deployments: recentDeployments(db),
    },
  };
}

function recentJobs(db: Db): JobRow[] {
  const rows = db.all<
    Omit<JobRow, "failure_kind" | "duration_ms"> & { failure_reason: string | null }
  >(sql`
    SELECT j.id, j.repo, j.issue_number, j.pr_number, j.status, j.failure_reason,
           j.created_at, j.started_at, j.finished_at,
           (SELECT count(*) FROM llm_calls c WHERE c.job_id = j.id) AS requests
      FROM jobs j ORDER BY j.id DESC LIMIT ${RECENT_LIMITS.jobs}`);
  return rows.map(({ failure_reason, ...row }) => ({
    id: row.id,
    repo: row.repo,
    issue_number: row.issue_number,
    pr_number: row.pr_number,
    status: row.status,
    failure_kind: failureKind(failure_reason),
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: span(row.started_at, row.finished_at),
    requests: row.requests,
  }));
}

function recentRuns(db: Db): RunRow[] {
  const rows = db.all<Omit<RunRow, "duration_ms">>(sql`
    SELECT id, job_id, phase, attempt, model, outcome, turns, requests, tool_calls,
           blocked_calls, compactions, verdict, started_at, finished_at
      FROM agent_runs ORDER BY id DESC LIMIT ${RECENT_LIMITS.runs}`);
  return rows.map((row) => ({ ...row, duration_ms: span(row.started_at, row.finished_at) }));
}

function recentDeployments(db: Db): DeployRow[] {
  const rows = db.all<{
    id: number;
    repo: string;
    job_id: number | null;
    commit_sha: string;
    status: string;
    failed_stage: string | null;
    rolled_back: number;
    revert_pr_number: number | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
  }>(sql`
    SELECT id, repo, job_id, commit_sha, status, failed_stage, rolled_back, revert_pr_number,
           created_at, started_at, finished_at
      FROM deployments ORDER BY id DESC LIMIT ${RECENT_LIMITS.deployments}`);
  return rows.map((row) => ({
    id: row.id,
    repo: row.repo,
    job_id: row.job_id,
    commit: row.commit_sha.slice(0, 12),
    status: row.status,
    failed_stage: row.failed_stage,
    rolled_back: row.rolled_back === 1,
    revert_pr_number: row.revert_pr_number,
    created_at: row.created_at,
    finished_at: row.finished_at,
    duration_ms: span(row.started_at ?? row.created_at, row.finished_at),
  }));
}
