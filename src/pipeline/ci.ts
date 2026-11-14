/**
 * CI 待ちの見回り（009 research R1・R3）。Worker（LLM を使う工程）とは別のループで、`ci_waiting` のジョブについて
 * PR の状態とチェックの結果を取り直し、merged・failed・やり直しの印・通過を決める。LLM は呼ばない。
 *
 *   PR がマージ済み        → ci_waiting → merged
 *   PR が閉じた            → failed（pr_closed）
 *   ci_status が pending:
 *     すべて成功           → ci_status = passed（マージを待つ。時間切れなし）
 *     失敗あり・上限未満    → ci_status = failed（やり直しの印）→ Worker を起こす
 *     失敗あり・上限        → failed（ci_failed）
 *     途中・期限切れ        → failed（ci_timeout）
 */

import { and, eq, isNull } from "drizzle-orm";
import type { CheckRunInfo } from "../github/port.ts";
import { listCiJobsToCheck, markPendingCiJobs } from "../queue/jobs.ts";
import { type Job, jobEvents, jobs } from "../queue/schema.ts";
import { type FailedCheck, failJob, type ReportDeps, refreshCiSection } from "./report.ts";
import { StateTransitionError, transition } from "./state.ts";

export type CiConclusion =
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "failure"; failed: FailedCheck[] };

/** 成功として扱う終わり方 */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * チェックの一覧から CI の結論を決める（research R1）。終わっていないものがある・0件なら pending、
 * すべて終わって成功・中立・スキップだけなら success、それ以外が1つでもあれば failure
 */
export function concludeCi(runs: readonly CheckRunInfo[]): CiConclusion {
  if (runs.length === 0) return { kind: "pending" };
  if (runs.some((run) => run.status !== "completed")) return { kind: "pending" };
  const failed = runs
    .filter((run) => !PASSING_CONCLUSIONS.has(run.conclusion ?? ""))
    .map((run) => ({ name: run.name, conclusion: run.conclusion ?? "unknown" }));
  return failed.length === 0 ? { kind: "success" } : { kind: "failure", failed };
}

export interface CiMonitorDeps extends ReportDeps {
  /** やり直しの印を付けたら Worker を起こす */
  wakeWorker: () => void;
  /** 見回りの間隔。既定は [worker].ci_check_interval_seconds */
  intervalMs?: number;
}

export type CiCheckResult =
  | "merged"
  | "closed"
  | "passed"
  | "retry"
  | "failed"
  | "timeout"
  | "pending"
  | "skipped";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function note(deps: ReportDeps, jobId: number, detail: object): void {
  const now = deps.now ?? Date.now;
  deps.db
    .insert(jobEvents)
    .values({ job_id: jobId, type: "note", detail: JSON.stringify(detail), created_at: now() })
    .run();
}

/**
 * 1件を評価する（research R3）。例外を投げない。GitHub を呼べなければ印を残して skipped（次の周で取り直す）。
 * 記録・PR の本文・報告は、条件付きの更新が1行を変えたときだけ書くので、同じジョブを2回評価しても重複しない
 */
export async function checkCiJob(deps: CiMonitorDeps, job: Job): Promise<CiCheckResult> {
  const { db, github, config, logger } = deps;
  const now = deps.now ?? Date.now;
  const log = logger.child({ jobId: job.id });
  const eventAt = job.ci_event_at;
  /** 評価の前に読んだ印だけを消す（評価中に届いた知らせの印は残す） */
  const clearEvent = () => {
    db.update(jobs)
      .set({ ci_event_at: null })
      .where(
        and(
          eq(jobs.id, job.id),
          eventAt === null ? isNull(jobs.ci_event_at) : eq(jobs.ci_event_at, eventAt),
        ),
      )
      .run();
  };

  if (job.status !== "ci_waiting") return "skipped";
  if (job.pr_number === null || job.head_sha === null) {
    log.error("ci_waiting なのに PR の番号か commit がありません");
    clearEvent();
    return "skipped";
  }

  try {
    const pr = await github.getPullRequest({ repo: job.repo, number: job.pr_number });
    if (pr.merged) {
      try {
        transition(db, job.id, "ci_waiting", "merged", now(), { pr_number: job.pr_number }, {
          ci_event_at: null,
        });
      } catch (error) {
        if (error instanceof StateTransitionError) return "skipped";
        throw error;
      }
      note(deps, job.id, { kind: "merged", pr_number: job.pr_number });
      log.info({ pr: job.pr_number }, "PR がマージされました");
      await refreshCiSection(deps, job);
      return "merged";
    }
    if (pr.state === "closed") {
      await failJob(deps, job, "pr_closed", `PR #${job.pr_number} がマージされずに閉じられました`);
      return "closed";
    }
    if (job.ci_status !== "pending") {
      // passed はマージを、failed は Worker のやり直しを待つ
      clearEvent();
      return "skipped";
    }

    const conclusion = concludeCi(await github.getCheckRuns({ repo: job.repo, sha: job.head_sha }));
    const attempt = job.ci_retries + 1;
    /** pending のまま、評価した commit のときだけ ci_status を変える */
    const settle = (status: "passed" | "failed"): boolean =>
      db
        .update(jobs)
        .set({ ci_status: status, ci_event_at: null, updated_at: now() })
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, "ci_waiting"),
            eq(jobs.ci_status, "pending"),
            eq(jobs.head_sha, job.head_sha as string),
          ),
        )
        .run().changes === 1;

    if (conclusion.kind === "success") {
      if (!settle("passed")) return "skipped";
      note(deps, job.id, {
        kind: "ci_result",
        head_sha: job.head_sha,
        conclusion: "success",
        failed: [],
        attempt,
      });
      log.info({ attempt }, "CI が通りました");
      await refreshCiSection(deps, job);
      return "passed";
    }

    if (conclusion.kind === "failure") {
      const result = {
        kind: "ci_result",
        head_sha: job.head_sha,
        conclusion: "failure",
        failed: conclusion.failed,
        attempt,
      };
      if (job.ci_retries < config.limits.ci_retries) {
        if (!settle("failed")) return "skipped";
        note(deps, job.id, result);
        log.info({ attempt, failed: conclusion.failed }, "CI が失敗しました。やり直します");
        await refreshCiSection(deps, job);
        deps.wakeWorker();
        return "retry";
      }
      note(deps, job.id, result);
      log.info({ attempt, failed: conclusion.failed }, "CI が失敗しました。やり直しの上限です");
      await failJob(deps, job, "ci_failed", `CI が失敗しました（${attempt} 回目）`, {
        failedChecks: conclusion.failed,
      });
      return "failed";
    }

    if (job.ci_deadline !== null && job.ci_deadline <= now()) {
      log.info("CI 待ちの期限を過ぎました");
      await failJob(
        deps,
        job,
        "ci_timeout",
        `CI の結論が ${config.limits.ci_wait_timeout_minutes} 分以内に出ませんでした`,
      );
      return "timeout";
    }
    clearEvent();
    return "pending";
  } catch (error) {
    // GitHub を呼べない → 印を残して次の周で取り直す
    log.warn({ error: errorText(error) }, "CI の結果を確かめられませんでした");
    return "skipped";
  }
}

export interface CiMonitor {
  /** 起動時の取り直しの印を付けてからループを始める */
  start(): void;
  /** 受付が呼ぶ。待ちを打ち切って次の周を始める */
  wake(): void;
  /** 評価中の1件が終わるまで待つ */
  stop(): Promise<void>;
}

/** 見回りのループ（research R3）。1周で対象を古い順に1件ずつ評価し、間隔だけ待つ（起こされたらすぐ次の周） */
export function createCiMonitor(deps: CiMonitorDeps): CiMonitor {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? deps.config.worker.ci_check_interval_seconds * 1000;
  let started = false;
  let stopping = false;
  let woken = false;
  let loop: Promise<void> | undefined;
  let interruptSleep: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        interruptSleep = undefined;
        resolve();
      }
      interruptSleep = done;
    });

  async function run(): Promise<void> {
    while (!stopping) {
      woken = false;
      let targets: Job[] = [];
      try {
        targets = listCiJobsToCheck(deps.db, now());
      } catch (error) {
        deps.logger.error({ err: error }, "CI 待ちのジョブを読めません");
      }
      for (const job of targets) {
        if (stopping) break;
        await checkCiJob(deps, job);
      }
      if (stopping) break;
      if (!woken) await sleep(intervalMs);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      try {
        const marked = markPendingCiJobs(deps.db, now());
        if (marked > 0) deps.logger.info({ jobs: marked }, "CI 待ちのジョブの結果を取り直します");
      } catch (error) {
        deps.logger.error({ err: error }, "起動時に CI 待ちのジョブに印を付けられませんでした");
      }
      loop = run();
    },
    wake() {
      woken = true;
      interruptSleep?.();
    },
    async stop() {
      stopping = true;
      interruptSleep?.();
      await loop;
    },
  };
}
