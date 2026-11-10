import type { FactoryConfig } from "../config.ts";
import type { Db } from "../queue/db.ts";
import { countLlmCallsForJob, countLlmCallsInMonth } from "../queue/llm-calls.ts";
import { monthRange } from "../queue/month.ts";
import { budget } from "../queue/schema.ts";

export type BudgetScope = "monthly" | "job";

/** 予算切れ。メッセージは機械で読める `budget_exceeded:<scope> limit=<n> used=<n>`（research R9） */
export class BudgetExceededError extends Error {
  readonly scope: BudgetScope;
  readonly limit: number;
  readonly used: number;

  constructor(scope: BudgetScope, limit: number, used: number) {
    super(`budget_exceeded:${scope} limit=${limit} used=${used}`);
    this.name = "BudgetExceededError";
    this.scope = scope;
    this.limit = limit;
    this.used = used;
  }
}

const BUDGET_MESSAGE = /^budget_exceeded:(monthly|job) limit=(\d+) used=(\d+)/;

/** メッセージから予算切れを復元する（ストリームの errorMessage で運ぶため） */
export function parseBudgetExceeded(message: string | undefined): BudgetExceededError | undefined {
  const match = message?.match(BUDGET_MESSAGE);
  if (!match) return undefined;
  return new BudgetExceededError(match[1] as BudgetScope, Number(match[2]), Number(match[3]));
}

/**
 * 月（設定のタイムゾーン）→ ジョブの順に残量を確かめる。足りていれば undefined。
 * 消費件数は llm_calls の件数（成功・失敗・取り消しを問わず送った回数）。上限の正は設定ファイル。
 */
export function checkBudget(
  db: Db,
  config: FactoryConfig,
  jobId: number | null,
  now: number,
): BudgetExceededError | undefined {
  const monthlyLimit = config.budget.monthly_requests;
  const monthlyUsed = countLlmCallsInMonth(db, now, config.budget.timezone);
  if (monthlyUsed >= monthlyLimit) {
    return new BudgetExceededError("monthly", monthlyLimit, monthlyUsed);
  }
  if (jobId !== null) {
    const jobLimit = config.budget.per_job_requests;
    const jobUsed = countLlmCallsForJob(db, jobId);
    if (jobUsed >= jobLimit) return new BudgetExceededError("job", jobLimit, jobUsed);
  }
  return undefined;
}

/**
 * 新しいジョブを受け付けてよいか（原則 V）。月の残り（月の上限 − 今月の消費）が1ジョブの上限を下回ったら受け付けない。
 * 実際に受付を止める処理と、止めた時刻の記録は 007 が行う。
 */
export function canAcceptNewJob(
  db: Db,
  config: FactoryConfig,
  now: number,
): { accept: boolean; remaining: number } {
  const used = countLlmCallsInMonth(db, now, config.budget.timezone);
  const remaining = Math.max(0, config.budget.monthly_requests - used);
  return { accept: remaining >= config.budget.per_job_requests, remaining };
}

/** その月の budget 行を用意する（なければ作る）。判断には使わない（受付を止めた時刻は 007 が書く） */
export function ensureBudgetMonth(db: Db, config: FactoryConfig, now: number): void {
  const { key } = monthRange(now, config.budget.timezone);
  db.insert(budget)
    .values({ month: key, monthly_limit: config.budget.monthly_requests, created_at: now })
    .onConflictDoNothing({ target: budget.month })
    .run();
}
