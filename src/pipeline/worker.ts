import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cloneForJob } from "../github/git.ts";
import { claimNextQueuedJob, listInterruptedJobs } from "../queue/jobs.ts";
import { type Job, jobs } from "../queue/schema.ts";
import { type FailJobExtra, type FailureKind, failJob, type ReportDeps } from "./report.ts";
import type { PipelineInput, PipelinePhase, PipelineResult } from "./run.ts";
import { isTerminal, StateTransitionError, transition } from "./state.ts";

/**
 * 005 の入口（runPipelineInSandbox と同じ形。research R2）。作業場の作成と破棄は入口が行う。
 * 007 では型を詰め直さず、PipelineResult をそのまま受け取る
 */
export type PipelinePort = (input: Omit<PipelineInput, "workspace">) => Promise<PipelineResult>;

export interface WorkerDeps extends ReportDeps {
  pipeline: PipelinePort;
  /**
   * 003 の依存のインストール（installDependencies に ["sh", "-c", config.pipeline.install_command]）。
   * 終了コードと標準エラーの末尾を返す。install_command が空なら呼ばない。テストでは偽物
   */
  install: (jobId: number, workdir: string) => Promise<{ exitCode: number; stderrTail: string }>;
  /**
   * 003 の作業場の片付け（removeStaleSandboxes）。jobId を省くと全部。
   * 停止の合図・期限で、インストール中のコンテナを消して install を戻らせるのにも使う（research R11）
   */
  removeSandboxes: (jobId?: number) => Promise<void>;
  /** ジョブの期限の長さ。既定は [limits] job_timeout_minutes。テストで短くする */
  jobTimeoutMs?: number;
  /** stop() が処理中のジョブを待つ上限。既定 5000。過ぎたら状態を変えずに resolve（research R11） */
  stopTimeoutMs?: number;
  /** 取得元。既定は https://github.com。テストでは file:// の bare リポジトリ */
  cloneBaseUrl?: string;
}

export interface Worker {
  start(): void;
  /** 受付が積んだときに呼ぶ。待ちを打ち切ってすぐ取り出す */
  wake(): void;
  /**
   * 取り出しを止め、処理中のジョブを中断して failed（stopped）にしてから resolve。
   * stopTimeoutMs を過ぎたら状態を変えずに resolve する（次の起動で restarted として報告される）
   */
  stop(): Promise<void>;
}

const MAX_REASON_CHARS = 200;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return Array.from(line).slice(0, MAX_REASON_CHARS).join("");
}

/** 005 の結果を分類する（research R2 の表）。message は failure_reason 用の短い文、detail は報告の詳細 */
export function classifyOutcome(result: PipelineResult): {
  kind: FailureKind;
  message: string;
  detail?: string;
} {
  switch (result.outcome) {
    case "passed":
      return {
        kind: "shipping_not_available",
        message: "判定に合格（出荷の工程は 008 で作る）",
        detail: result.verdict?.reasons ?? result.reason,
      };
    case "rejected":
      return {
        kind: "judge_rejected",
        message: firstLine(result.reason) || "判定に合格しませんでした",
        detail: result.reason,
      };
    case "failed": {
      const text = result.error ?? result.reason;
      return { kind: "pipeline_failed", message: firstLine(text) || "工程が失敗", detail: text };
    }
    case "budget_exceeded": {
      const text = result.error ?? result.reason;
      return { kind: "budget_exceeded", message: firstLine(text) || "予算切れ", detail: text };
    }
    case "timeout":
      return { kind: "timeout", message: "005 の工程が期限を過ぎました" };
    case "aborted":
      return { kind: "stopped", message: "停止の合図で中断しました" };
  }
}

/**
 * onPhase の中身（research R7）。現在の状態と同じなら何もしない（planning → planning、implementing → implementing）。
 * 表にない遷移は warn のログだけで、例外を投げない（005 の工程を止めない）
 */
export function advancePhase(deps: WorkerDeps, jobId: number, phase: PipelinePhase): void {
  const now = deps.now ?? Date.now;
  const current = deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!current || current.status === phase || isTerminal(current.status)) return;
  try {
    transition(deps.db, jobId, current.status, phase, now());
  } catch (error) {
    if (!(error instanceof StateTransitionError)) throw error;
    deps.logger.warn({ jobId, err: error }, "工程の境目の遷移を拒否しました");
  }
}

function jobDir(deps: WorkerDeps, jobId: number): string {
  return join(deps.config.storage.work_dir, `job-${jobId}`);
}

/** work_dir の下の job-* をすべて消す（起動時。FR-028） */
function removeAllJobDirs(deps: WorkerDeps): void {
  let names: string[];
  try {
    names = readdirSync(deps.config.storage.work_dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^job-\d+$/.test(name)) {
      rmSync(join(deps.config.storage.work_dir, name), { recursive: true, force: true });
    }
  }
}

/**
 * 起動時の掃除（FR-028）。planning〜judging のジョブを failed（restarted）にして報告し、
 * 残った作業場（コンテナ）と作業ディレクトリを消す
 */
export async function recoverOnStartup(deps: WorkerDeps): Promise<{ failedJobs: number }> {
  const interrupted = listInterruptedJobs(deps.db);
  for (const job of interrupted) {
    await failJob(deps, job, "restarted", "前回の起動で処理中のまま止まりました");
  }
  await deps.removeSandboxes().catch((error: unknown) => {
    deps.logger.error({ err: error }, "起動時に作業場の残骸を片付けられませんでした");
  });
  removeAllJobDirs(deps);
  if (interrupted.length > 0) {
    deps.logger.warn(
      { jobs: interrupted.map((job) => job.id) },
      "中断されたジョブを failed にしました",
    );
  }
  return { failedJobs: interrupted.length };
}

interface Running {
  jobId: number;
  /** 停止の合図 */
  stop: AbortController;
  done: Promise<void>;
  /** stop() が待つのをやめた。以降は DB に書かない */
  abandoned: boolean;
}

export function createWorker(deps: WorkerDeps): Worker {
  const { db, config, logger, github } = deps;
  const now = deps.now ?? Date.now;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5000;
  let started = false;
  let stopping = false;
  let stopped: Promise<void> | undefined;
  let loop: Promise<void> | undefined;
  let running: Running | undefined;
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

  async function processJob(job: Job, state: Running): Promise<void> {
    const { id } = job;
    const timeoutMs = deps.jobTimeoutMs ?? config.limits.job_timeout_minutes * 60_000;
    const deadline = (job.started_at ?? now()) + timeoutMs;
    const dir = jobDir(deps, id);
    const workdir = join(dir, "repo");
    const branch = `agent/issue-${job.issue_number}-job-${id}`;
    const secrets: string[] = [];
    const log = logger.child({ jobId: id });

    // 期限は1つの合図にまとめる（タイマーと now() の比較がずれて、期限切れを取りこぼさないように）
    const expiry = AbortSignal.timeout(Math.max(0, deadline - now()));
    const interruption = (): FailureKind | undefined =>
      state.stop.signal.aborted ? "stopped" : expiry.aborted ? "timeout" : undefined;
    const interruptionMessage = (kind: FailureKind) =>
      kind === "stopped" ? "停止の合図で中断しました" : "ジョブの期限を過ぎました";
    const fail = async (kind: FailureKind, message: string, extra: FailJobExtra = {}) => {
      if (state.abandoned) return;
      await failJob(deps, job, kind, message, { ...extra, secrets });
    };

    try {
      // 準備: Issue の題と本文、取得、作業ブランチ（research R2・R8）
      const prepare = AbortSignal.any([state.stop.signal, expiry]);
      let issue: { title: string; body: string };
      try {
        issue = await github.getIssue({ repo: job.repo, issueNumber: job.issue_number });
        prepare.throwIfAborted();
        const access = await github.getCloneAccess({ repo: job.repo });
        secrets.push(access.token);
        prepare.throwIfAborted();
        await cloneForJob({
          repo: job.repo,
          token: access.token,
          defaultBranch: access.defaultBranch,
          dir: workdir,
          branch,
          signal: prepare,
          ...(deps.cloneBaseUrl ? { baseUrl: deps.cloneBaseUrl } : {}),
        });
      } catch (error) {
        const kind = interruption();
        await fail(
          kind ?? "clone_failed",
          kind ? interruptionMessage(kind) : firstLine(errorText(error)),
          {
            stage: "prepare",
            ...(kind ? {} : { detail: errorText(error) }),
          },
        );
        return;
      }
      db.update(jobs).set({ branch, updated_at: now() }).where(eq(jobs.id, id)).run();

      // 依存のインストール（research R13）。期限が来たらコンテナを消して戻らせる（research R11）
      if (config.pipeline.install_command !== "") {
        const onExpiry = () => {
          deps.removeSandboxes(id).catch((error: unknown) => {
            log.error({ err: error }, "期限でインストールの作業場を消せませんでした");
          });
        };
        expiry.addEventListener("abort", onExpiry, { once: true });
        let installed: { exitCode: number; stderrTail: string };
        try {
          installed = await deps.install(id, workdir);
        } catch (error) {
          installed = { exitCode: -1, stderrTail: errorText(error) };
        } finally {
          expiry.removeEventListener("abort", onExpiry);
        }
        const kind = interruption();
        if (kind) {
          await fail(kind, interruptionMessage(kind), { stage: "prepare" });
          return;
        }
        if (installed.exitCode !== 0) {
          await fail("install_failed", `終了コード ${installed.exitCode}`, {
            stage: "prepare",
            detail: installed.stderrTail,
          });
          return;
        }
      }
      const before = interruption();
      if (before) {
        await fail(before, interruptionMessage(before), { stage: "prepare" });
        return;
      }

      // 計画から判定まで（005）
      let result: PipelineResult;
      try {
        result = await deps.pipeline({
          jobId: id,
          workdir,
          issue,
          instruction: job.instruction,
          deadline,
          signal: state.stop.signal,
          onPhase: (phase) => {
            if (!state.abandoned) advancePhase(deps, id, phase);
          },
        });
      } catch (error) {
        await fail("internal_error", firstLine(errorText(error)), { detail: errorText(error) });
        return;
      }
      const { kind, message, detail } = classifyOutcome(result);
      log.info({ outcome: result.outcome, kind, requests: result.requests }, "工程が終わりました");
      await fail(kind, message, {
        result: { retries: result.retries, diffStat: result.diffStat },
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (error) {
      log.error({ err: error }, "ジョブの処理で想定外の例外");
      await fail("internal_error", firstLine(errorText(error))).catch((inner: unknown) => {
        log.error({ err: inner }, "internal_error の報告にも失敗しました");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await deps.removeSandboxes(id).catch((error: unknown) => {
        log.error({ err: error }, "作業場を片付けられませんでした");
      });
    }
  }

  async function run(): Promise<void> {
    while (!stopping) {
      let job: Job | undefined;
      try {
        job = claimNextQueuedJob(db, now());
      } catch (error) {
        logger.error({ err: error }, "キューからジョブを取り出せません");
      }
      if (!job) {
        await sleep(config.worker.poll_interval_seconds * 1000);
        continue;
      }
      const state: Running = {
        jobId: job.id,
        stop: new AbortController(),
        done: Promise.resolve(),
        abandoned: false,
      };
      logger.info(
        { jobId: job.id, repo: job.repo, issue: job.issue_number },
        "ジョブを取り出しました",
      );
      state.done = processJob(job, state).catch((error: unknown) => {
        logger.error({ err: error, jobId: job.id }, "ジョブの処理が例外で終わりました");
      });
      running = state;
      await state.done;
      running = undefined;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      loop = run();
    },
    wake() {
      interruptSleep?.();
    },
    stop() {
      stopped ??= (async () => {
        stopping = true;
        interruptSleep?.();
        const current = running;
        if (current) {
          current.stop.abort(new Error("stopped"));
          // インストール中なら、コンテナを消して installDependencies を戻らせる
          await deps.removeSandboxes(current.jobId).catch((error: unknown) => {
            logger.error({ err: error, jobId: current.jobId }, "停止で作業場を消せませんでした");
          });
          let timer: NodeJS.Timeout | undefined;
          const timedOut = await Promise.race([
            current.done.then(() => false),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(true), stopTimeoutMs);
            }),
          ]);
          clearTimeout(timer);
          if (timedOut) {
            current.abandoned = true;
            logger.warn(
              { jobId: current.jobId },
              "停止の待ちの上限を過ぎました。次の起動で restarted として報告します",
            );
            return;
          }
        }
        await loop;
      })();
      return stopped;
    },
  };
}
