import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { FactoryConfig } from "../config.ts";
import type { CiEvent } from "../github/port.ts";
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

/** LLM を使う工程の状態（起動時の掃除の対象）。ci_waiting は 009 の見回り（pipeline/ci.ts）で扱う */
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

// ---- 009: CI の待ち（research R2〜R5） ----

/**
 * 次のジョブを取り出す（009 research R5）。やり直しを待つ ci_waiting（ci_status = failed）を最も古い順に先に
 * implementing にし（ci_retries + 1、ci_status・ci_deadline は NULL）、なければ queued を planning にする。
 * どちらも即時トランザクションの中の1文なので、二重に取らない
 */
export function claimNextJob(
  db: Db,
  now: number,
): { kind: "new" | "ci_retry"; job: Job } | undefined {
  const retry = db.transaction(
    (tx) => {
      const claimed = tx
        .update(jobs)
        .set({
          status: "implementing",
          ci_retries: sql`${jobs.ci_retries} + 1`,
          ci_status: null,
          ci_deadline: null,
          ci_event_at: null,
          updated_at: now,
        })
        .where(
          sql`${jobs.id} = (SELECT ${jobs.id} FROM ${jobs} WHERE ${jobs.status} = 'ci_waiting' AND ${jobs.ci_status} = 'failed' ORDER BY ${jobs.updated_at}, ${jobs.id} LIMIT 1)`,
        )
        .returning()
        .get();
      if (claimed) {
        tx.insert(jobEvents)
          .values({
            job_id: claimed.id,
            type: "state_changed",
            from_status: "ci_waiting",
            to_status: "implementing",
            detail: JSON.stringify({ reason: "ci_retry", ci_retry: claimed.ci_retries }),
            created_at: now,
          })
          .run();
      }
      return claimed;
    },
    { behavior: "immediate" },
  );
  if (retry) return { kind: "ci_retry", job: retry };
  const next = claimNextQueuedJob(db, now);
  return next ? { kind: "new", job: next } : undefined;
}

/**
 * 受付: CI の知らせに結び付く ci_waiting のジョブに ci_event_at を入れ、ci_event を記録する（research R2）。
 * check_suite は repo・branch・head_sha、pull_request_closed は repo・pr_number で結び付ける。なければ undefined
 */
export function noteCiEvent(
  db: Db,
  event: CiEvent,
  now: number,
  delivery: string,
): Job | undefined {
  if (event.kind === "check_suite" && event.headBranch === null) return undefined;
  return db.transaction(
    (tx) => {
      const match =
        event.kind === "check_suite"
          ? and(
              eq(jobs.repo, event.repo),
              eq(jobs.branch, event.headBranch as string),
              eq(jobs.head_sha, event.headSha),
            )
          : and(eq(jobs.repo, event.repo), eq(jobs.pr_number, event.prNumber));
      const noted = tx
        .update(jobs)
        .set({ ci_event_at: now })
        .where(and(eq(jobs.status, "ci_waiting"), match))
        .returning()
        .get();
      if (noted) {
        tx.insert(jobEvents)
          .values({
            job_id: noted.id,
            type: "note",
            detail: JSON.stringify({
              kind: "ci_event",
              event: event.kind === "check_suite" ? "check_suite" : "pull_request",
              delivery,
              ...(event.kind === "check_suite"
                ? { head_sha: event.headSha }
                : { merged: event.merged }),
            }),
            created_at: now,
          })
          .run();
      }
      return noted;
    },
    { behavior: "immediate" },
  );
}

/** 見回りの対象（research R3）: ci_waiting で、知らせの印がある、または pending で期限切れ。古い順 */
export function listCiJobsToCheck(db: Db, now: number): Job[] {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "ci_waiting"),
        or(
          isNotNull(jobs.ci_event_at),
          and(eq(jobs.ci_status, "pending"), lte(jobs.ci_deadline, now)),
        ),
      ),
    )
    .orderBy(asc(jobs.id))
    .all();
}

/** 起動時: pending の ci_waiting すべてに印を付ける（停止中の知らせの取りこぼしを拾う）。付けた件数を返す */
export function markPendingCiJobs(db: Db, now: number): number {
  return db
    .update(jobs)
    .set({ ci_event_at: now })
    .where(and(eq(jobs.status, "ci_waiting"), eq(jobs.ci_status, "pending")))
    .run().changes;
}
