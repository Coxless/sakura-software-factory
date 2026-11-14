import { and, eq } from "drizzle-orm";
import type { Db } from "../queue/db.ts";
import {
  type Job,
  type JobStatus,
  jobEvents,
  jobs,
  TERMINAL_JOB_STATUSES,
} from "../queue/schema.ts";

/**
 * 状態機械（docs/design/03 3章、007 data-model.md）。failed へは終わりの状態以外のどこからでも移れるので、表には書かない。
 * 工程の遷移はこの表で決め打ちにする（原則 II）。
 */
export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["planning"],
  planning: ["implementing"],
  implementing: ["testing"],
  testing: ["implementing", "judging"],
  judging: ["implementing", "pr_opened"],
  pr_opened: ["ci_waiting"],
  ci_waiting: ["implementing", "merged"],
  merged: ["deploying"],
  deploying: ["deployed", "rolled_back"],
  deployed: [],
  rolled_back: [],
  failed: [],
};

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (to === "failed") return !isTerminal(from);
  return TRANSITIONS[from].includes(to);
}

export class StateTransitionError extends Error {
  readonly jobId: number;
  readonly from: JobStatus;
  readonly to: JobStatus;

  constructor(jobId: number, from: JobStatus, to: JobStatus, reason: string) {
    super(`ジョブ #${jobId} を ${from} から ${to} に移せません: ${reason}`);
    this.name = "StateTransitionError";
    this.jobId = jobId;
    this.from = from;
    this.to = to;
  }
}

/** 遷移と一緒に書く列 */
export type TransitionFields = Partial<
  Pick<
    Job,
    | "failure_reason"
    | "branch"
    | "pr_number"
    | "base_sha"
    | "head_sha"
    | "ci_status"
    | "ci_deadline"
    | "ci_event_at"
  >
>;

/**
 * 状態を1つ進める。状態の更新と job_events の state_changed を1つのトランザクションで書く。
 * 表にない遷移・現在の状態が from でない（ないジョブを含む）ときは StateTransitionError で、何も変えない。
 * 終わりの状態に移したら finished_at を入れる。
 */
export function transition(
  db: Db,
  jobId: number,
  from: JobStatus,
  to: JobStatus,
  now: number,
  detail?: object,
  fields: TransitionFields = {},
): Job {
  return transitionPath(db, jobId, [from, to], now, detail, fields);
}

/**
 * 状態を path の順に続けて進める（008: judging → pr_opened → ci_waiting）。すべての遷移と記録を1つのトランザクションで
 * 書くので、途中の状態のまま残らない。1つでも表にない・現在の状態が path[0] でなければ、何も変えない。
 * fields は最後の更新で書く
 */
export function transitionPath(
  db: Db,
  jobId: number,
  path: readonly [JobStatus, JobStatus, ...JobStatus[]],
  now: number,
  detail?: object,
  fields: TransitionFields = {},
): Job {
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1] as JobStatus;
    const to = path[i] as JobStatus;
    if (!canTransition(from, to)) {
      throw new StateTransitionError(jobId, from, to, "遷移の表にありません");
    }
  }
  return db.transaction(
    (tx) => {
      let updated: Job | undefined;
      for (let i = 1; i < path.length; i++) {
        const from = path[i - 1] as JobStatus;
        const to = path[i] as JobStatus;
        const last = i === path.length - 1;
        updated = tx
          .update(jobs)
          .set({
            ...(last ? fields : {}),
            status: to,
            updated_at: now,
            ...(isTerminal(to) ? { finished_at: now } : {}),
          })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, from)))
          .returning()
          .get();
        if (!updated) {
          throw new StateTransitionError(jobId, from, to, `現在の状態が ${from} ではありません`);
        }
        tx.insert(jobEvents)
          .values({
            job_id: jobId,
            type: "state_changed",
            from_status: from,
            to_status: to,
            detail: detail === undefined ? null : JSON.stringify(detail),
            created_at: now,
          })
          .run();
      }
      return updated as Job;
    },
    { behavior: "immediate" },
  );
}
