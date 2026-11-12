import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import { ensureBudgetMonth } from "../llm/budget.ts";
import type { Db } from "./db.ts";
import { monthRange } from "./month.ts";
import { budget, type Job, type JobStatus, jobEvents, jobs, type NewJob } from "./schema.ts";

/**
 * 最も古い queued のジョブを1件だけ planning にして返す。なければ undefined。
 * 選ぶ・書き換えるを1文にし、即時トランザクションで実行するので、別の接続から同時に呼んでも二重に取らない。
 */
export function claimNextQueuedJob(db: Db, now: number): Job | undefined {
  return db.transaction(
    (tx) =>
      tx
        .update(jobs)
        .set({ status: "planning", started_at: now, updated_at: now })
        .where(
          sql`${jobs.id} = (SELECT ${jobs.id} FROM ${jobs} WHERE ${jobs.status} = 'queued' ORDER BY ${jobs.created_at}, ${jobs.id} LIMIT 1)`,
        )
        .returning()
        .get(),
    { behavior: "immediate" },
  );
}

/** 受付が積むジョブの中身 */
export type NewJobInput = Pick<
  NewJob,
  "repo" | "issue_number" | "trigger_comment_id" | "requested_by" | "instruction"
>;

/**
 * queued で積む。(repo, trigger_comment_id) が既にあれば積まずに既存のジョブを返す（配送の重複・再送に冪等）。
 * note を渡すと、新しく積んだときだけ job_events の note（detail は note の JSON）を同じトランザクションで書く。
 */
export function enqueueJob(
  db: Db,
  input: NewJobInput,
  now: number,
  note?: object,
): { job: Job; created: boolean } {
  return db.transaction(
    (tx) => {
      const inserted = tx
        .insert(jobs)
        .values({ ...input, status: "queued", created_at: now, updated_at: now })
        .onConflictDoNothing({ target: [jobs.repo, jobs.trigger_comment_id] })
        .returning()
        .get();
      if (inserted) {
        if (note !== undefined) {
          tx.insert(jobEvents)
            .values({
              job_id: inserted.id,
              type: "note",
              detail: JSON.stringify(note),
              created_at: now,
            })
            .run();
        }
        return { job: inserted, created: true };
      }
      const existing = tx
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.repo, input.repo), eq(jobs.trigger_comment_id, input.trigger_comment_id)),
        )
        .get();
      if (!existing) throw new Error("積んだはずのジョブが見つかりません");
      return { job: existing, created: false };
    },
    { behavior: "immediate" },
  );
}

/** その月の受付を止めた時刻を記録する（既に記録があれば何もしない。原則 V） */
export function markIntakeStopped(db: Db, config: FactoryConfig, now: number): void {
  ensureBudgetMonth(db, config, now);
  const { key } = monthRange(now, config.budget.timezone);
  db.update(budget)
    .set({ intake_stopped_at: now })
    .where(and(eq(budget.month, key), isNull(budget.intake_stopped_at)))
    .run();
}

/** LLM を使う工程の状態（起動時の掃除の対象）。pr_opened 以降は 008・009 で扱う */
export const INTERRUPTIBLE_STATUSES = [
  "planning",
  "implementing",
  "testing",
  "judging",
] as const satisfies readonly JobStatus[];

/** 起動時の掃除の対象（planning〜judging）を古い順に */
export function listInterruptedJobs(db: Db): Job[] {
  return db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, [...INTERRUPTIBLE_STATUSES]))
    .orderBy(jobs.id)
    .all();
}
