/**
 * 計画から判定までの工程（005 US4、research R7）。工程の遷移はここに決め打ちで書く（原則 II）。
 *
 *   計画（渡されたら飛ばす）
 *   for 回 = 1 .. judge_retries + 1:
 *     実装（完了を告げたら工程内テスト。失敗は同じ会話に差し込む。上限まで）
 *     → テストが通った・変更がある → 判定
 *     合格なら passed。不合格なら理由と今の diff を渡して、新しい会話でやり直す
 *   使い切ったら rejected
 *
 * 状態（jobs.status）を進めるのは 007。本機能は onPhase で境目を知らせるだけにする。Pi に依存しない。
 */
import { join } from "node:path";
import type { Feedback } from "../harness/context.ts";
import { truncateMiddle } from "../harness/results.ts";
import { type Workspace, workspaceFromSandbox } from "../harness/workspace.ts";
import { apiKeyEnvOf } from "../llm/provider.ts";
import type { GateDeps } from "../llm/stream.ts";
import { countLlmCallsForJob } from "../queue/llm-calls.ts";
import { createSandbox } from "../sandbox/docker.ts";
import {
  maskDeep,
  openTraceWriter,
  type TraceRecordBody,
  type TraceWriter,
  traceFileName,
} from "../trace/writer.ts";
import { type CheckRun, checkFeedback, checksSummary, runChecks } from "./checks.ts";
import { type DiffSource, type DiffStat, gitDiffSource, listGitFiles } from "./diff.ts";
import { type ImplementerOutcome, startImplementer } from "./implement.ts";
import type { OneShotOutcome } from "./oneshot.ts";
import { makePlan, type Plan, planToText } from "./plan.ts";
import { judge, type Verdict, verdictFeedback } from "./verify.ts";

export type PipelineOutcome =
  | "passed"
  | "rejected"
  | "failed"
  | "budget_exceeded"
  | "timeout"
  | "aborted";

/** 工程の境目。007 の JobStatus と同じ名前 */
export type PipelinePhase = "planning" | "implementing" | "testing" | "judging";

export interface PipelineInput {
  jobId: number;
  /** 004 の Workspace（exec を含む） */
  workspace: Workspace;
  /** ホストの作業ディレクトリ（git の作業ツリー）。diff とファイル一覧を取る */
  workdir: string;
  issue: { title: string; body: string };
  /** @agent のあとの依頼の本文 */
  instruction?: string;
  /** 渡したら計画役を飛ばす（CLI の --plan） */
  plan?: string;
  /** UTC の Unix ミリ秒 */
  deadline: number;
  signal?: AbortSignal;
  /** 工程の境目。例外は握りつぶしてログに残す */
  onPhase?: (phase: PipelinePhase, round: number) => void;
}

export interface PipelineDeps {
  gate: GateDeps;
  now?: () => number;
  /** 既定は git（diff.ts）。テストでは偽物 */
  diff?: DiffSource;
  /** 既定は git ls-files。テストでは偽物 */
  listFiles?: (workdir: string) => Promise<string[]>;
}

export type RoundReason =
  | "judge_failed"
  | "checks_failed"
  | "no_changes"
  | "max_turns"
  | "blocked_repeatedly";

export interface RoundSummary {
  /** 1 始まり */
  round: number;
  implement: { outcome: ImplementerOutcome; turns: number; requests: number; runId: number };
  checks: {
    status: "passed" | "failed" | "skipped" | "not_run";
    /** 工程内テストを実行した回数 */
    runs: number;
    /** 失敗を実装役に差し込んだ回数 */
    fedBack: number;
  };
  verdict: "pass" | "fail" | "not_judged";
  reason?: RoundReason;
  diffStat: DiffStat;
}

export interface PipelineResult {
  outcome: PipelineOutcome;
  /** 計画役の出力（渡された計画なら undefined） */
  plan?: Plan;
  /** 実装役・検査役に渡した計画の文章 */
  planText: string;
  /** 最後の判定 */
  verdict?: Verdict;
  /** 最後の不合格・失敗の理由（合格なら判定の理由）。マスク済み */
  reason: string;
  rounds: RoundSummary[];
  /** やり直しの回数（実装工程の回数 − 1） */
  retries: number;
  /** ジョブ内の llm_calls の増分 */
  requests: number;
  /** 最後の diff（008 の出荷前チェック用。マスクしない。表示・記録するときは呼び出し側がマスクする） */
  diff: string;
  diffStat: DiffStat;
  /** failed などの原因（マスク済み） */
  error?: string;
  /** 軌跡のファイルの絶対パス */
  tracePath: string;
}

const EMPTY_STAT: DiffStat = { files: 0, insertions: 0, deletions: 0 };

class TraceWriteError extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ROUND_REASON_TEXT: Record<Exclude<RoundReason, "judge_failed" | "checks_failed">, string> = {
  no_changes:
    "作業ディレクトリに変更がありませんでした。計画に従ってファイルを変更してから作業を終えてください。",
  max_turns:
    "ターン数の上限に達したため、作業を途中で打ち切りました。今の変更を確かめ、残りの作業を短い手順で終えてください。",
  blocked_repeatedly:
    "ツールの呼び出しが検査に拒否され続けたため、作業を打ち切りました。拒否された操作（禁止されたパスへの書き込みや危険なコマンド）を避けて進めてください。",
};

/** 計画から判定までを1回実行する。例外は投げない */
export async function runPipeline(
  deps: PipelineDeps,
  input: PipelineInput,
): Promise<PipelineResult> {
  const { gate } = deps;
  const { config, db } = gate;
  const now = deps.now ?? gate.now ?? Date.now;
  const diffSource = deps.diff ?? gitDiffSource;
  const listFiles = deps.listFiles ?? listGitFiles;
  const secrets = [gate.apiKey, process.env[apiKeyEnvOf(config)]].filter(
    (s): s is string => typeof s === "string" && s !== "",
  );
  const mask = (text: string) => maskDeep(text, secrets) as string;
  const requestsBefore = countLlmCallsForJob(db, input.jobId);
  const tracePath = join(config.storage.trace_dir, traceFileName(input.jobId));

  // 期限と呼び出し側の中断を1つの signal にまとめ、どちらで止まったかを旗で見分ける
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const remaining = input.deadline - now();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (remaining <= 0) {
    timedOut = true;
    controller.abort();
  } else {
    deadlineTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, remaining);
    deadlineTimer.unref?.();
  }
  const abortReason = (): "timeout" | "aborted" => (timedOut ? "timeout" : "aborted");

  let writer: TraceWriter | undefined;
  const write = (record: TraceRecordBody) => {
    if (!writer) return;
    try {
      writer.write(record);
    } catch (error) {
      throw new TraceWriteError(`軌跡に書けませんでした: ${errorText(error)}`);
    }
  };
  const phase = (name: PipelinePhase, round: number) => {
    write({ type: "phase", name, round });
    try {
      input.onPhase?.(name, round);
    } catch (error) {
      gate.logger.warn(
        { err: error, jobId: input.jobId, phase: name },
        "onPhase が例外を投げました",
      );
    }
  };

  const rounds: RoundSummary[] = [];
  let plan: Plan | undefined;
  let planText = input.plan ?? "";
  let verdict: Verdict | undefined;
  let reason = "";
  let diff = "";
  let diffStat: DiffStat = { ...EMPTY_STAT };

  const run = async (): Promise<{ outcome: PipelineOutcome; error?: string }> => {
    // 開始前の検査（LLM を呼ばない）
    if (config.models.verifier === config.models.implementer) {
      return {
        outcome: "failed",
        error: `[models].verifier と [models].implementer が同じモデル（${config.models.verifier}）です。実装と検査は別系統のモデルにしてください（原則 III）`,
      };
    }
    const issueText = `${input.issue.title}\n\n${input.issue.body}`.trim();
    const instruction = input.instruction?.trim() ?? "";
    if (issueText === "" && instruction === "") {
      return { outcome: "failed", error: "Issue と依頼の本文が空です" };
    }
    try {
      writer = openTraceWriter({
        traceDir: config.storage.trace_dir,
        jobId: input.jobId,
        runId: 0,
        phase: "pipeline",
        attempt: 0,
        secrets,
        now,
      });
    } catch (error) {
      throw new TraceWriteError(`軌跡に書けませんでした: ${errorText(error)}`);
    }
    if (config.pipeline.check_commands.length === 0) {
      gate.logger.warn(
        { jobId: input.jobId },
        "[pipeline].check_commands が空のため、工程内テストを飛ばします",
      );
    }
    const base = await diffSource.base(input.workdir);
    write({
      type: "pipeline_start",
      deadline: input.deadline,
      judgeRetries: config.limits.judge_retries,
      checkCommands: [...config.pipeline.check_commands],
      maxCheckFeedbacks: config.pipeline.max_check_feedbacks,
      planGiven: input.plan !== undefined,
      baseCommit: base,
    });
    if (controller.signal.aborted) return { outcome: abortReason() };

    // 計画
    if (input.plan === undefined) {
      phase("planning", 0);
      const agentsMd = await input.workspace.readAgentsMd();
      const files = await listFiles(input.workdir).catch(() => []);
      const planned = await makePlan(
        { gate, now },
        {
          jobId: input.jobId,
          issue: input.issue,
          ...(instruction === "" ? {} : { instruction }),
          agentsMd,
          files,
          signal: controller.signal,
          abortReason,
        },
      );
      if (planned.kind !== "ok") return oneShotFailure(planned, "計画を得られません");
      plan = planned.value;
      planText = planToText(plan);
    }

    const implementerIssue =
      instruction === "" ? issueText : `${issueText}\n\n## 依頼の本文\n${instruction}`;
    const checksSecrets = secrets;
    let feedback: Feedback[] = [];
    const maxRounds = config.limits.judge_retries + 1;
    for (let round = 1; round <= maxRounds; round++) {
      if (controller.signal.aborted) return { outcome: abortReason() };
      phase("implementing", round);

      let lastChecks: CheckRun | undefined;
      let checkRuns = 0;
      let fedBack = 0;
      const onComplete = async (signal: AbortSignal): Promise<string | undefined> => {
        phase("testing", round);
        const checks = await runChecks(input.workspace, config, {
          deadline: input.deadline,
          signal,
          now,
          secrets: checksSecrets,
        });
        checkRuns += 1;
        lastChecks = checks;
        if (checks.kind === "skipped") return undefined;
        const canFeed =
          checks.kind === "failed" &&
          fedBack < config.pipeline.max_check_feedbacks &&
          !signal.aborted;
        write({
          type: "check_run",
          round,
          index: checkRuns,
          results: checks.results,
          passed: checks.kind === "passed",
          fedBack: canFeed,
        });
        if (checks.kind === "unavailable") throw new Error(checks.error);
        if (!canFeed) return undefined;
        fedBack += 1;
        phase("implementing", round);
        return checkFeedback(checks);
      };

      const implemented = await startImplementer(
        { gate, now },
        {
          jobId: input.jobId,
          workspace: input.workspace,
          issue: implementerIssue,
          plan: planText,
          feedback,
          deadline: input.deadline,
          signal: controller.signal,
          onComplete,
        },
      ).result;

      const summary: RoundSummary = {
        round,
        implement: {
          outcome: implemented.outcome,
          turns: implemented.turns,
          requests: implemented.requests,
          runId: implemented.runId,
        },
        checks: {
          status:
            lastChecks === undefined
              ? "not_run"
              : lastChecks.kind === "passed" || lastChecks.kind === "skipped"
                ? lastChecks.kind
                : "failed",
          runs: checkRuns,
          fedBack,
        },
        verdict: "not_judged",
        diffStat: { ...EMPTY_STAT },
      };
      const endRound = (next: "retry" | "finish") => {
        rounds.push(summary);
        write({
          type: "round_end",
          round,
          implementOutcome: summary.implement.outcome,
          checks: summary.checks.status,
          diffStat: summary.diffStat,
          verdict: summary.verdict,
          ...(summary.reason ? { reason: summary.reason } : {}),
          next,
        });
      };

      // 工程全体を止める終わり方
      switch (implemented.outcome) {
        case "budget_exceeded":
          endRound("finish");
          return { outcome: "budget_exceeded", error: implemented.error ?? "予算切れ" };
        case "timeout":
          endRound("finish");
          return { outcome: "timeout" };
        case "aborted":
          endRound("finish");
          return { outcome: abortReason() };
        case "failed":
          endRound("finish");
          return {
            outcome: "failed",
            error: implemented.error ?? "実装工程が失敗しました",
          };
        default:
          break;
      }

      const current = await diffSource.diff(input.workdir, base);
      diff = current.diff;
      diffStat = current.stat;
      summary.diffStat = current.stat;

      let reasonText: string;
      if (implemented.outcome === "max_turns" || implemented.outcome === "blocked_repeatedly") {
        summary.reason = implemented.outcome;
        reasonText = ROUND_REASON_TEXT[implemented.outcome];
      } else if (lastChecks?.kind === "failed") {
        summary.reason = "checks_failed";
        reasonText = `工程内テストが通りませんでした。\n${checkFeedback(lastChecks)}`;
      } else if (diff === "") {
        summary.reason = "no_changes";
        reasonText = ROUND_REASON_TEXT.no_changes;
      } else {
        if (controller.signal.aborted) {
          endRound("finish");
          return { outcome: abortReason() };
        }
        phase("judging", round);
        const judged = await judge(
          { gate, now },
          {
            jobId: input.jobId,
            issue: input.issue,
            ...(instruction === "" ? {} : { instruction }),
            planText,
            diff,
            checks: checksSummary(lastChecks),
            signal: controller.signal,
            abortReason,
          },
        );
        if (judged.kind !== "ok") {
          endRound("finish");
          return oneShotFailure(judged, "判定できません");
        }
        verdict = judged.value;
        summary.verdict = judged.value.verdict;
        if (judged.value.verdict === "pass") {
          reason = judged.value.reasons;
          endRound("finish");
          return { outcome: "passed" };
        }
        summary.reason = "judge_failed";
        reasonText = verdictFeedback(judged.value);
      }

      reason = reasonText;
      const last = round === maxRounds;
      endRound(last ? "finish" : "retry");
      if (last) break;
      feedback = [
        { title: "前回の結果（不合格）", body: reasonText },
        {
          title: "今の diff（前回までの変更。作業ディレクトリに残っています）",
          body: truncateMiddle(diff === "" ? "（変更なし）" : diff, config.pipeline.max_diff_chars)
            .text,
        },
      ];
    }
    return { outcome: "rejected" };
  };

  let outcome: PipelineOutcome;
  let error: string | undefined;
  try {
    ({ outcome, error } = await run());
  } catch (failure) {
    outcome = "failed";
    error =
      failure instanceof TraceWriteError
        ? failure.message
        : `計画から判定までの工程で予期しない例外: ${errorText(failure)}`;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  const requests = countLlmCallsForJob(db, input.jobId) - requestsBefore;
  const maskedError = error === undefined ? undefined : mask(error);
  if (outcome !== "passed" && outcome !== "rejected" && maskedError !== undefined) {
    reason = maskedError;
  }
  if (outcome === "timeout" && reason === "") reason = "ジョブの期限を過ぎました";
  if (outcome === "aborted" && reason === "") reason = "中断しました";
  try {
    write({
      type: "pipeline_end",
      outcome,
      rounds: rounds.length,
      requests,
      ...(maskedError === undefined ? {} : { error: maskedError }),
    });
  } catch (failure) {
    gate.logger.error(
      { err: failure, jobId: input.jobId },
      "軌跡の pipeline_end を書けませんでした",
    );
  }

  return {
    outcome,
    ...(plan === undefined ? {} : { plan }),
    planText,
    ...(verdict === undefined ? {} : { verdict }),
    reason: mask(reason),
    rounds,
    retries: Math.max(0, rounds.length - 1),
    requests,
    diff,
    diffStat,
    ...(maskedError === undefined ? {} : { error: maskedError }),
    tracePath,
  };
}

/** 1回呼び出しの失敗を工程の終わり方にする */
function oneShotFailure(
  out: Exclude<OneShotOutcome<unknown>, { kind: "ok" }>,
  label: string,
): { outcome: PipelineOutcome; error: string } {
  if (out.kind === "invalid") {
    return {
      outcome: "failed",
      error: `${label}（出力が2回とも決められた形に合いません）: ${out.errors.join(" / ")}`,
    };
  }
  return { outcome: out.kind, error: `${label}: ${out.error}` };
}

/**
 * 007 の PipelinePort の形: 作業ディレクトリから作業場を作り、runPipeline を回して片付ける。
 * 作業場を作れなければ failed。
 *
 * 007 での扱い（007 research R2。分類は src/pipeline/worker.ts の classifyOutcome）: passed → shipping_not_available、
 * rejected → judge_rejected、failed → pipeline_failed、budget_exceeded・timeout → 同名、aborted → stopped
 */
export async function runPipelineInSandbox(
  deps: PipelineDeps,
  input: Omit<PipelineInput, "workspace">,
): Promise<PipelineResult> {
  const { config } = deps.gate;
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
  try {
    sandbox = await createSandbox({
      jobId: input.jobId,
      workspace: input.workdir,
      sandbox: config.sandbox,
    });
  } catch (error) {
    const message = `作業場を作れません: ${errorText(error)}`;
    return {
      outcome: "failed",
      planText: input.plan ?? "",
      reason: message,
      rounds: [],
      retries: 0,
      requests: 0,
      diff: "",
      diffStat: { ...EMPTY_STAT },
      error: message,
      tracePath: join(config.storage.trace_dir, traceFileName(input.jobId)),
    };
  }
  try {
    return await runPipeline(deps, { ...input, workspace: workspaceFromSandbox(sandbox, config) });
  } finally {
    await sandbox.destroy().catch((error: unknown) => {
      deps.gate.logger.error({ err: error, jobId: input.jobId }, "作業場を片付けられませんでした");
    });
  }
}
