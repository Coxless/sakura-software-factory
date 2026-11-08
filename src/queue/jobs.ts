import { sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { type Job, jobs } from "./schema.ts";

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
