import { and, count, eq, gte, lt } from "drizzle-orm";
import type { Db } from "./db.ts";
import { monthRange } from "./month.ts";
import { llmCalls } from "./schema.ts";

/** `now` が `timeZone` で属する月の LLM 呼び出し件数（成功・失敗を問わず送った回数） */
export function countLlmCallsInMonth(db: Db, now: number, timeZone: string): number {
  const { start, end } = monthRange(now, timeZone);
  const row = db
    .select({ n: count() })
    .from(llmCalls)
    .where(and(gte(llmCalls.created_at, start), lt(llmCalls.created_at, end)))
    .get();
  return row?.n ?? 0;
}

/** ジョブの LLM 呼び出し件数 */
export function countLlmCallsForJob(db: Db, jobId: number): number {
  const row = db.select({ n: count() }).from(llmCalls).where(eq(llmCalls.job_id, jobId)).get();
  return row?.n ?? 0;
}
