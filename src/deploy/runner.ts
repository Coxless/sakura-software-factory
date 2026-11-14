/**
 * デプロイの実行器（010 research R2・R3・R7〜R11、contracts/module-api.md 7章）。Worker・CI の見回りとは別のループで、
 * 積んだ順に1件ずつ、ジョブの結び付け → 取得 → ビルド → 入れ替え → ヘルスチェック → 成功かロールバック、を行う。
 * LLM は呼ばない。GitHub の操作は GitHubPort、Docker の操作は StagingRuntime だけを使う。
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { fetchCommit, type RevertSkipReason, revertRange } from "../github/git.ts";
import { markMerged } from "../pipeline/ci.ts";
import {
  failJob,
  maskWith,
  postRollbackReport,
  type ReportDeps,
  refreshDeploySection,
  renderRevertPullRequest,
} from "../pipeline/report.ts";
import { StateTransitionError, transition } from "../pipeline/state.ts";
import {
  claimNextDeployment,
  enqueueDeployment,
  type FinishFields,
  finishDeployment,
  getDeployment,
  interruptRunningDeployments,
  latestDeployment,
  listDeployments,
  listSucceededDeployments,
  updateRunningDeployment,
} from "../queue/deployments.ts";
import { type Deployment, type Job, jobEvents, jobs } from "../queue/schema.ts";
import { type HealthResult, waitHealthy } from "./health.ts";
import { healthUrlFor, imageTagFor, type StagingRuntime } from "./staging.ts";

export interface DeployerDeps extends ReportDeps {
  staging: StagingRuntime;
  /** テストでは偽物 */
  health?: typeof waitHealthy;
  /** テストでは file:// の bare リポジトリ */
  cloneBaseUrl?: string;
  /** 待ちの間隔。既定は [worker].poll_interval_seconds */
  intervalMs?: number;
}

export type DeployOutcome =
  | { kind: "succeeded" }
  | { kind: "failed"; stage: "fetch" | "build" | "interrupted" }
  | {
      kind: "rolled_back";
      stage: "release" | "health";
      to: string | null;
      healthy: boolean | null;
      revertPr: number | null;
    };

const REVERT_SKIP_TEXT: Record<RevertSkipReason, string> = {
  no_range: "push の範囲が分かりません（ブランチの作成、または前のデプロイの記録がない）",
  not_ancestor: "push の前の commit が祖先ではありません（強制の push）",
  not_in_branch: "commit が既定のブランチの履歴にありません",
  conflict: "打ち消しが既定のブランチの今の内容と衝突しました",
  empty: "変更はすでに打ち消されています",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deployDir(deps: DeployerDeps, kind: "deploy" | "revert", id: number): string {
  return join(deps.config.storage.work_dir, `${kind}-${id}`);
}

function note(deps: ReportDeps, jobId: number, detail: object): void {
  const now = deps.now ?? Date.now;
  deps.db
    .insert(jobEvents)
    .values({ job_id: jobId, type: "note", detail: JSON.stringify(detail), created_at: now() })
    .run();
}

function getJob(deps: ReportDeps, id: number): Job | undefined {
  return deps.db.select().from(jobs).where(eq(jobs.id, id)).get();
}

/**
 * push の先頭の commit をジョブに結び付ける（research R3）。ジョブが merged（ci_waiting でマージ済みなら merged に進めてから）なら
 * deploying に移して返す。結び付いたが進めないジョブ・結び付かない push は undefined。例外を投げない
 */
async function linkJob(deps: DeployerDeps, d: Deployment): Promise<Job | undefined> {
  const { db, github, logger } = deps;
  const now = deps.now ?? Date.now;
  let job: Job | undefined;
  try {
    const prNumber = await github.findMergedPullRequest({ repo: d.repo, sha: d.commit_sha });
    if (prNumber === undefined) return undefined;
    job = db
      .select()
      .from(jobs)
      .where(and(sql`lower(${jobs.repo}) = lower(${d.repo})`, eq(jobs.pr_number, prNumber)))
      .orderBy(desc(jobs.id))
      .get();
    if (!job) return undefined;
    updateRunningDeployment(db, d.id, { job_id: job.id });
    if (job.status === "ci_waiting") {
      const pr = await github.getPullRequest({ repo: job.repo, number: prNumber });
      if (pr.merged) await markMerged(deps, job);
      job = getJob(deps, job.id);
    }
  } catch (error) {
    const message = maskWith(`ジョブに結び付けられませんでした: ${errorText(error)}`);
    updateRunningDeployment(db, d.id, { error: message });
    logger.warn({ deployment: d.id, error: message }, "デプロイをジョブに結び付けられませんでした");
    return undefined;
  }
  if (job?.status !== "merged") return undefined;
  try {
    transition(db, job.id, "merged", "deploying", now(), { deployment_id: d.id });
  } catch (error) {
    if (error instanceof StateTransitionError) return undefined;
    throw error;
  }
  note(deps, job.id, {
    kind: "deploy_started",
    deployment_id: d.id,
    commit_sha: d.commit_sha,
    image_tag: d.image_tag,
  });
  await refreshDeploySection(deps, job);
  return getJob(deps, job.id);
}

function finish(deps: DeployerDeps, d: Deployment, fields: FinishFields): Deployment {
  const now = deps.now ?? Date.now;
  finishDeployment(deps.db, d.id, fields, now());
  return getDeployment(deps.db, d.id) ?? d;
}

function noteResult(deps: DeployerDeps, job: Job | undefined, d: Deployment): void {
  if (!job) return;
  note(deps, job.id, {
    kind: "deploy_result",
    deployment_id: d.id,
    status: d.status,
    failed_stage: d.failed_stage,
    rolled_back: d.rolled_back,
    rolled_back_to: d.rolled_back_to,
    rollback_healthy: d.rollback_healthy,
  });
}

/** 中断（停止の合図）。ステージングはそのとき動いていた版のまま残る（FR-017） */
async function interrupted(
  deps: DeployerDeps,
  d: Deployment,
  job: Job | undefined,
): Promise<DeployOutcome> {
  const done = finish(deps, d, {
    status: "failed",
    stage: "interrupted",
    error: "ファクトリーの停止で中断しました",
  });
  noteResult(deps, job, done);
  if (job) {
    await failJob(deps, job, "stopped", "デプロイの途中で停止しました");
    await refreshDeploySection(deps, job);
  }
  deps.logger.warn({ deployment: d.id }, "デプロイを中断しました");
  return { kind: "failed", stage: "interrupted" };
}

/** 取得・ビルドの失敗。ステージングは触らない（FR-014） */
async function buildFailed(
  deps: DeployerDeps,
  d: Deployment,
  job: Job | undefined,
  stage: "fetch" | "build",
  error: unknown,
): Promise<DeployOutcome> {
  const message = maskWith(errorText(error));
  const done = finish(deps, d, { status: "failed", stage, error: message });
  noteResult(deps, job, done);
  deps.logger.error({ deployment: d.id, stage, error: message }, "デプロイに失敗しました");
  if (job) {
    await failJob(
      deps,
      job,
      "deploy_failed",
      `${stage === "fetch" ? "取得" : "ビルド"}に失敗しました`,
      {
        detail: `${stage === "fetch" ? "取得" : "ビルド"}に失敗しました（commit \`${d.commit_sha.slice(0, 7)}\`）。\n\n${message.slice(-1500)}`,
      },
    );
    await refreshDeploySection(deps, job);
  }
  return { kind: "failed", stage };
}

function healthOf(deps: DeployerDeps) {
  const { staging } = deps.config;
  const check = deps.health ?? waitHealthy;
  return (signal?: AbortSignal) =>
    check({
      url: healthUrlFor(staging),
      timeoutMs: staging.health_timeout_seconds * 1000,
      intervalMs: staging.health_interval_seconds * 1000,
      successes: staging.health_successes,
      ...(signal ? { signal } : {}),
    });
}

/** 成功したデプロイのあとに、残す数より古いイメージを消す（research R11）。例外を投げない */
async function pruneImages(deps: DeployerDeps, d: Deployment): Promise<void> {
  try {
    const keep = new Set(
      listSucceededDeployments(deps.db, d.repo)
        .slice(0, deps.config.staging.keep_images)
        .map((row) => row.image_tag),
    );
    keep.add(d.image_tag);
    const candidates = [
      ...new Set(
        listDeployments(deps.db, d.repo)
          .map((row) => row.image_tag)
          .filter((tag) => !keep.has(tag)),
      ),
    ];
    if (candidates.length === 0) return;
    const removed = await deps.staging.removeImages(candidates);
    if (removed.length > 0) deps.logger.info({ removed }, "古いステージングのイメージを消しました");
  } catch (error) {
    deps.logger.warn({ error: errorText(error) }, "古いイメージを片付けられませんでした");
  }
}

/** revert PR を作る（research R8）。作れなければ理由を返す。例外を投げない */
async function createRevertPullRequest(
  deps: DeployerDeps,
  d: Deployment,
  job: Job | undefined,
  health: HealthResult | undefined,
  rolledBackTo: string | null,
  stage: "release" | "health",
): Promise<{ number: number | null; error?: string }> {
  const { github } = deps;
  const dir = deployDir(deps, "revert", d.id);
  rmSync(dir, { recursive: true, force: true });
  let secrets: string[] = [];
  try {
    const access = await github.getCloneAccess({ repo: d.repo });
    secrets = [access.token];
    const bot = await github.getBotIdentity({ repo: d.repo });
    const { title, body } = renderRevertPullRequest({
      deployment: { ...d, failed_stage: stage },
      prNumber: job?.pr_number ?? null,
      ...(health ? { health } : {}),
      rolledBackTo,
    });
    const result = await revertRange({
      repo: d.repo,
      token: access.token,
      defaultBranch: access.defaultBranch,
      before: d.before_sha,
      after: d.commit_sha,
      branch: `factory/revert-${d.commit_sha.slice(0, 7)}`,
      message: `${title}\n\nThis reverts ${(d.before_sha ?? "").slice(0, 12)}..${d.commit_sha.slice(0, 12)}.`,
      author: bot,
      dir,
      ...(deps.cloneBaseUrl ? { baseUrl: deps.cloneBaseUrl } : {}),
    });
    if (result.kind === "skipped") {
      return {
        number: null,
        error: `revert PR を作りませんでした: ${REVERT_SKIP_TEXT[result.reason]}`,
      };
    }
    const pr = await github.createPullRequest({
      repo: d.repo,
      head: result.branch,
      base: access.defaultBranch,
      title,
      body: maskWith(body, secrets),
      draft: false,
    });
    if (job)
      note(deps, job.id, {
        kind: "revert_pr",
        deployment_id: d.id,
        pr_number: pr.number,
        url: pr.url,
      });
    deps.logger.info({ deployment: d.id, pr: pr.number }, "revert PR を作りました");
    return { number: pr.number };
  } catch (error) {
    const message = maskWith(`revert PR を作れませんでした: ${errorText(error)}`, secrets);
    deps.logger.error({ deployment: d.id, error: message }, "revert PR を作れませんでした");
    return { number: null, error: message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 入れ替え・ヘルスチェックの失敗で、直前に成功した版に戻して revert PR を作る（research R7・R8） */
async function rollBack(
  deps: DeployerDeps,
  d: Deployment,
  job: Job | undefined,
  stage: "release" | "health",
  health: HealthResult | undefined,
  cause: string,
): Promise<DeployOutcome> {
  const { db, staging, logger } = deps;
  const notes: string[] = [cause];
  let to: string | null = null;
  let healthy: boolean | null = null;

  const previous = listSucceededDeployments(db, d.repo).find((row) => row.id !== d.id);
  const available = previous
    ? await staging.imageExists(previous.image_tag).catch(() => false)
    : false;
  if (previous && available) {
    to = previous.image_tag;
    try {
      await staging.up({ image: previous.image_tag });
      healthy = (await healthOf(deps)()).healthy;
    } catch (error) {
      healthy = false;
      notes.push(maskWith(`戻し先への入れ替えに失敗しました: ${errorText(error)}`));
    }
  } else {
    if (previous) notes.push(`戻し先のイメージ ${previous.image_tag} がありません`);
    try {
      await staging.down({});
    } catch (error) {
      notes.push(maskWith(`ステージングを止められませんでした: ${errorText(error)}`));
    }
  }
  if (healthy === false) {
    logger.error(
      { deployment: d.id, to },
      "戻した版のヘルスチェックも通りません。ステージングを確かめてください",
    );
  }

  const revert = await createRevertPullRequest(deps, d, job, health, to, stage);
  if (revert.error) {
    notes.push(revert.error);
    if (job) {
      note(deps, job.id, { kind: "revert_skipped", deployment_id: d.id, reason: revert.error });
    }
  }
  const done = finish(deps, d, {
    status: "failed",
    stage,
    rolledBack: true,
    rolledBackTo: to,
    rollbackHealthy: healthy,
    revertPrNumber: revert.number,
    error: revert.error ?? notes.join(" / "),
  });
  noteResult(deps, job, done);
  logger.warn(
    { deployment: d.id, stage, to, healthy, revertPr: revert.number },
    "ステージングを戻しました",
  );
  if (job) {
    try {
      transition(db, job.id, "deploying", "rolled_back", (deps.now ?? Date.now)(), {
        deployment_id: d.id,
      });
    } catch (error) {
      if (!(error instanceof StateTransitionError)) throw error;
    }
    await refreshDeploySection(deps, job);
    await postRollbackReport(deps, job, { deployment: done, ...(health ? { health } : {}) });
  }
  return { kind: "rolled_back", stage, to, healthy, revertPr: revert.number };
}

/** 1件を最後まで処理する（contracts/module-api.md 7章）。例外を投げない */
export async function runDeployment(
  deps: DeployerDeps,
  deployment: Deployment,
  signal: AbortSignal,
): Promise<DeployOutcome> {
  const { staging, logger, github, config } = deps;
  const d = deployment;
  const log = logger.child({ deployment: d.id, commit: d.commit_sha.slice(0, 12) });
  let job: Job | undefined;
  const dir = deployDir(deps, "deploy", d.id);
  try {
    job = await linkJob(deps, d);
    if (signal.aborted) return await interrupted(deps, d, job);
    log.info({ job: job?.id, image: d.image_tag }, "デプロイを始めます");

    rmSync(dir, { recursive: true, force: true });
    const fetchSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(config.staging.build_timeout_seconds * 1000),
    ]);
    try {
      const access = await github.getCloneAccess({ repo: d.repo });
      await fetchCommit({
        repo: d.repo,
        token: access.token,
        sha: d.commit_sha,
        dir,
        signal: fetchSignal,
        ...(deps.cloneBaseUrl ? { baseUrl: deps.cloneBaseUrl } : {}),
      });
    } catch (error) {
      if (signal.aborted) return await interrupted(deps, d, job);
      return await buildFailed(deps, d, job, "fetch", error);
    }

    try {
      await staging.build({ dir, image: d.image_tag, signal });
    } catch (error) {
      if (signal.aborted) return await interrupted(deps, d, job);
      return await buildFailed(deps, d, job, "build", error);
    }
    rmSync(dir, { recursive: true, force: true });

    try {
      await staging.up({ image: d.image_tag, signal });
    } catch (error) {
      if (signal.aborted) return await interrupted(deps, d, job);
      return await rollBack(
        deps,
        d,
        job,
        "release",
        undefined,
        maskWith(`入れ替えに失敗しました: ${errorText(error)}`),
      );
    }

    const health = await healthOf(deps)(signal);
    if (signal.aborted) return await interrupted(deps, d, job);
    if (!health.healthy) {
      return await rollBack(
        deps,
        d,
        job,
        "health",
        health,
        `ヘルスチェックが通りませんでした（${health.attempts} 回、最後: ${health.last}）`,
      );
    }

    const done = finish(deps, d, { status: "succeeded" });
    noteResult(deps, job, done);
    log.info({ attempts: health.attempts }, "デプロイしました");
    await pruneImages(deps, done);
    if (job) {
      try {
        transition(deps.db, job.id, "deploying", "deployed", (deps.now ?? Date.now)(), {
          deployment_id: d.id,
        });
      } catch (error) {
        if (!(error instanceof StateTransitionError)) throw error;
      }
      await refreshDeploySection(deps, job);
    }
    return { kind: "succeeded" };
  } catch (error) {
    // 想定外（DB の失敗など）。行を失敗にして、ジョブは内部エラーで報告する
    const message = maskWith(errorText(error));
    log.error({ error: message }, "デプロイの途中で想定外のエラーが起きました");
    try {
      finish(deps, d, { status: "failed", stage: "build", error: `内部エラー: ${message}` });
      if (job) await failJob(deps, job, "internal_error", message);
    } catch (inner) {
      log.error({ error: errorText(inner) }, "デプロイの失敗を記録できませんでした");
    }
    return { kind: "failed", stage: "build" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Deployer {
  start(): void;
  /** 受付が呼ぶ。待ちを打ち切って次の周を始める */
  wake(): void;
  /** 実行中のデプロイを打ち切って、終わるまで待つ */
  stop(): Promise<void>;
}

/** 実行器のループ（research R2）。[staging].repo が空なら動かない */
export function createDeployer(deps: DeployerDeps): Deployer {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? deps.config.worker.poll_interval_seconds * 1000;
  const controller = new AbortController();
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
      let next: Deployment | undefined;
      try {
        next = claimNextDeployment(deps.db, now());
      } catch (error) {
        deps.logger.error({ err: error }, "デプロイの待ちを読めません");
      }
      if (next) {
        await runDeployment(deps, next, controller.signal);
        continue;
      }
      if (stopping) break;
      if (!woken) await sleep(intervalMs);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (deps.config.staging.repo === "") {
        deps.logger.info("[staging].repo が空なので、ステージングへのデプロイは行いません");
        return;
      }
      loop = run();
    },
    wake() {
      woken = true;
      interruptSleep?.();
    },
    async stop() {
      stopping = true;
      controller.abort(new Error("ファクトリーの停止"));
      interruptSleep?.();
      await loop;
    },
  };
}

/**
 * 起動時の掃除（research R9）。running のデプロイを interrupted にし、結び付いた deploying のジョブを
 * failed（restarted）にして報告する。デプロイ・revert の作業ディレクトリを消す。queued は残す
 */
export async function recoverDeployments(deps: DeployerDeps): Promise<{ interrupted: number }> {
  const rows = interruptRunningDeployments(deps.db, (deps.now ?? Date.now)());
  for (const d of rows) {
    if (d.job_id === null) continue;
    const job = getJob(deps, d.job_id);
    if (job?.status !== "deploying") continue;
    noteResult(deps, job, d);
    await failJob(deps, job, "restarted", "前回の起動でデプロイの途中のまま止まりました");
    await refreshDeploySection(deps, job);
  }
  try {
    for (const name of readdirSync(deps.config.storage.work_dir)) {
      if (/^(deploy|revert)-\d+$/.test(name)) {
        rmSync(join(deps.config.storage.work_dir, name), { recursive: true, force: true });
      }
    }
  } catch {
    // work_dir がまだない
  }
  if (rows.length > 0) {
    deps.logger.warn({ deployments: rows.map((d) => d.id) }, "途中のデプロイを失敗にしました");
  }
  return { interrupted: rows.length };
}

/**
 * 起動時の取り直し（research R9）。既定のブランチの先頭が記録にない commit ならデプロイを積む。
 * before は最後に記録したデプロイの commit。例外を投げない
 */
export async function catchUpDeployments(
  deps: DeployerDeps,
): Promise<"queued" | "up_to_date" | "disabled" | "error"> {
  const { staging } = deps.config;
  if (staging.repo === "") return "disabled";
  try {
    const head = await deps.github.getDefaultBranchHead({ repo: staging.repo });
    const last = latestDeployment(deps.db, staging.repo);
    const { created } = enqueueDeployment(
      deps.db,
      {
        repo: staging.repo,
        commitSha: head.sha,
        beforeSha: last && last.commit_sha !== head.sha ? last.commit_sha : null,
        imageTag: imageTagFor(staging, head.sha),
      },
      (deps.now ?? Date.now)(),
    );
    if (created) {
      deps.logger.info({ commit: head.sha }, "停止中の main への push をデプロイに積みました");
      return "queued";
    }
    return "up_to_date";
  } catch (error) {
    deps.logger.warn(
      { error: maskWith(errorText(error)) },
      "起動時に既定のブランチの先頭を確かめられませんでした",
    );
    return "error";
  }
}
