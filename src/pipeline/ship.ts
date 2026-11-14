/**
 * 出荷の工程（008 US1、research R1〜R9）。判定に合格したジョブを、
 * commit → 出荷前チェック → push → PR → auto-merge か Draft → ci_waiting と進め、Issue に知らせる。
 * LLM は呼ばない。commit・push はホストで行い、作業場（コンテナ）は使わない。
 *
 * 009（research R11）: CI 失敗後のやり直し（update）では PR を作らず、前回の push からの変更を1つの commit にして
 * 早送りで push する。自動マージの条件は PR の変更全体（base_sha から）で評価し、振り分けは格下げだけにする。
 */

import { eq } from "drizzle-orm";
import { execa } from "execa";
import { changedFiles, commitForJob, pushBranch, ShipGitError } from "../github/git.ts";
import {
  DraftUnavailableError,
  type PullRequestRef,
  type PullRequestState,
} from "../github/port.ts";
import { countLlmCallsForJob } from "../queue/llm-calls.ts";
import { type Job, jobEvents, jobs } from "../queue/schema.ts";
import {
  type FailureKind,
  failJob,
  listCiEvents,
  maskWith,
  pullRequestTitle,
  type ReportDeps,
  renderCiSection,
  renderShipNotice,
  renderShipReport,
} from "./report.ts";
import type { PipelineResult } from "./run.ts";
import {
  type Condition,
  evaluateShipChecks,
  findInlineAllows,
  type SecretScan,
  type ShipCheckResult,
  scanSecrets,
} from "./ship-checks.ts";
import type { TransitionFields } from "./state.ts";
import { transitionPath } from "./state.ts";

export interface ShipDeps extends ReportDeps {
  /** gitleaks の実行ファイル。既定 "gitleaks" */
  gitleaksPath?: string;
  /** push 先。既定は https://github.com。テストでは file:// */
  cloneBaseUrl?: string;
  /** 秘密情報のスキャンの時間の上限。既定 120 秒 */
  scanTimeoutMs?: number;
}

export interface ShipInput {
  /** judging のジョブ */
  job: Job;
  workdir: string;
  branch: string;
  issue: { title: string };
  /** outcome == "passed" の 005 の結果 */
  result: PipelineResult;
  /** 停止の合図と期限。push の前だけ見る（FR-021） */
  interruption: () => "stopped" | "timeout" | undefined;
  /** 伏せる値（Worker と共有。push のトークンを足す） */
  secrets: string[];
  /**
   * CI 失敗後のやり直しの出荷（009 research R11）。ありなら PR を作らず、作業ブランチに追加の commit を早送りで
   * push する。baseSha は最初の出荷の基準（自動マージの条件を PR の変更全体で評価する）
   */
  update?: { baseSha: string; prNumber: number };
}

export type MergeDecisionKind = "auto_merge" | "draft" | "unsettled";

export type ShipOutcome =
  | { kind: "shipped"; prNumber: number; prUrl: string; decision: MergeDecisionKind }
  | {
      kind: "failed";
      failure: Extract<
        FailureKind,
        | "secret_detected"
        | "unshippable_change"
        | "ship_failed"
        | "stopped"
        | "timeout"
        | "internal_error"
        | "ci_unfixed"
        | "pr_closed"
      >;
    };

const DEFAULT_SCAN_TIMEOUT_MS = 120_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** PR の本文の1行に入れるので、GitHub のエラーの文の改行と連続する空白をまとめる */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** commit の diff（gitleaks:allow を探すため）。ホストの git の設定・フックを使わない */
async function commitDiff(dir: string, base: string, head: string): Promise<string> {
  const result = await execa(
    "git",
    [
      "-C",
      dir,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      base,
      head,
    ],
    {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      extendEnv: false,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return result.stdout;
}

/** gitleaks の結果に、追加行の gitleaks:allow を「見つかった」として足す（research R4） */
function withInlineAllows(scan: SecretScan, allows: { file: string; line: number }[]): SecretScan {
  if (allows.length === 0 || scan.status === "unavailable") return scan;
  const extra = allows.map((a) => ({ ...a, rule: "gitleaks-allow-comment" }));
  return {
    status: "found",
    findings: [...(scan.status === "found" ? scan.findings : []), ...extra],
  };
}

function note(deps: ShipDeps, jobId: number, type: "note" | "error", detail: object): void {
  const now = deps.now ?? Date.now;
  deps.db
    .insert(jobEvents)
    .values({ job_id: jobId, type, detail: JSON.stringify(detail), created_at: now() })
    .run();
}

/**
 * commit → 出荷前チェック → push → PR → 振り分け → 状態（ci_waiting）→ Issue に知らせる（contracts/module-api.md）。
 * 失敗は failJob（007）で Issue に報告してから返す。例外を投げない
 */
export async function shipJob(deps: ShipDeps, input: ShipInput): Promise<ShipOutcome> {
  const { github, config, logger } = deps;
  const { job, workdir, branch, result, secrets, update } = input;
  const log = logger.child({ jobId: job.id });
  let pushed = false;

  const fail = async (
    failure: Extract<ShipOutcome, { kind: "failed" }>["failure"],
    message: string,
    extra: { detail?: string; conditions?: readonly Condition[] } = {},
  ): Promise<ShipOutcome> => {
    await failJob(deps, job, failure, message, {
      ...extra,
      secrets,
      pushed,
      result: { retries: result.retries, diffStat: result.diffStat },
    });
    return { kind: "failed", failure };
  };

  try {
    // commit（research R2）
    let commit: { base: string; head: string } | undefined;
    try {
      const author = await github.getBotIdentity({ repo: job.repo });
      const title = pullRequestTitle(result.plan, job.issue_number);
      const message = [
        title,
        "",
        ...(result.plan ? [result.plan.summary, ""] : []),
        `Refs #${job.issue_number}`,
        `Factory-Job: ${job.id}`,
      ].join("\n");
      commit = await commitForJob({ dir: workdir, message, author });
    } catch (error) {
      return await fail("ship_failed", maskWith(errorText(error), secrets));
    }
    if (!commit) {
      return update
        ? await fail(
            "ci_unfixed",
            "CI の失敗を受けたやり直しで、前回の push からの変更がありません",
          )
        : await fail("internal_error", "判定に合格しましたが、作業ディレクトリに変更がありません");
    }

    // 出荷前チェック（research R3・R4）。やり直しでは diff の大きさ・禁止パスを PR の変更全体で見る（009 R11）。
    // 秘密情報のスキャンは新しい commit だけ（前回までの commit はスキャン済み）
    const changes = await changedFiles({
      dir: workdir,
      base: update ? update.baseSha : commit.base,
      head: commit.head,
    });
    const scan = await scanSecrets({
      dir: workdir,
      ...commit,
      timeoutMs: deps.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
      ...(deps.gitleaksPath ? { gitleaksPath: deps.gitleaksPath } : {}),
    });
    let allows: { file: string; line: number }[] = [];
    try {
      allows = findInlineAllows(await commitDiff(workdir, commit.base, commit.head));
    } catch (error) {
      log.warn({ err: error }, "gitleaks:allow を確かめるための diff を取れません");
    }
    let labels: { names: string[] } | { error: string };
    try {
      labels = {
        names: (await github.getIssue({ repo: job.repo, issueNumber: job.issue_number })).labels,
      };
    } catch (error) {
      labels = { error: maskWith(errorText(error), secrets) };
    }
    const checks: ShipCheckResult = evaluateShipChecks({
      config: config.auto_merge,
      verdictPassed: result.outcome === "passed" && result.verdict?.verdict !== "fail",
      workType: result.plan?.work_type,
      changes,
      secrets: withInlineAllows(scan, allows),
      labels,
    });
    note(deps, job.id, "note", {
      kind: "ship_checks",
      conditions: checks.conditions,
      unmet: checks.unmet,
      blocker: checks.blocker,
    });
    if (checks.blocker) {
      const message =
        checks.blocker === "secret_detected"
          ? "出荷前チェックで秘密情報が見つかった（または確かめられなかった）ため push しません"
          : "CI の定義（.github/workflows）を変更したため push しません";
      return await fail(checks.blocker, message, { conditions: checks.conditions });
    }

    // PR を作ったら judging から進めるので、push の前に状態を確かめる（PR だけできて状態が進まないことを防ぐ）
    const current = deps.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    if (current?.status !== "judging") {
      return await fail(
        "internal_error",
        `出荷の前の状態が judging ではありません（${current?.status ?? "なし"}）`,
      );
    }

    // push の前に、停止の合図と期限を確かめる（FR-021）
    const interrupted = input.interruption();
    if (interrupted) {
      return await fail(
        interrupted,
        interrupted === "stopped" ? "停止の合図で中断しました" : "ジョブの期限を過ぎました",
      );
    }

    // やり直しでは、push の前に PR がまだ開いていることを確かめる（009 FR-019）
    let existing: PullRequestState | undefined;
    if (update) {
      try {
        existing = await github.getPullRequest({ repo: job.repo, number: update.prNumber });
      } catch (error) {
        return await fail(
          "ship_failed",
          maskWith(`PR #${update.prNumber} の状態を確かめられません: ${errorText(error)}`, secrets),
        );
      }
      if (existing.state !== "open" || existing.merged) {
        return await fail(
          "pr_closed",
          `PR #${update.prNumber} が${existing.merged ? "マージ済み" : "閉じられている"}ため push しません`,
        );
      }
    }

    // push（research R5）。トークンは取り直す（インストールトークンは1時間で切れる）
    let defaultBranch: string;
    try {
      const access = await github.getCloneAccess({ repo: job.repo });
      secrets.push(access.token);
      defaultBranch = access.defaultBranch;
      await pushBranch({
        dir: workdir,
        repo: job.repo,
        token: access.token,
        branch,
        ...(deps.cloneBaseUrl ? { baseUrl: deps.cloneBaseUrl } : {}),
      });
    } catch (error) {
      const text = error instanceof ShipGitError ? error.message : errorText(error);
      return await fail("ship_failed", maskWith(text, secrets));
    }
    pushed = true;

    // PR と振り分け（research R6）
    const wantAutoMerge = checks.unmet.length === 0;
    const notes: string[] = [];
    const requests = countLlmCallsForJob(deps.db, job.id);
    const reportInput = (decision: MergeDecisionKind, prNotes: readonly string[]) => ({
      jobId: job.id,
      issueNumber: job.issue_number,
      result,
      requests,
      changes,
      conditions: checks.conditions,
      unmet: checks.unmet,
      decision,
      notes: prNotes,
    });
    const title = pullRequestTitle(result.plan, job.issue_number);
    const now = deps.now ?? Date.now;
    const ciFields = {
      head_sha: commit.head,
      ci_status: "pending" as const,
      ci_deadline: now() + config.limits.ci_wait_timeout_minutes * 60_000,
      ci_event_at: null,
    };
    const shippedNote = (prNumber: number, prUrl: string, decision: MergeDecisionKind) => ({
      kind: "shipped",
      pr_number: prNumber,
      pr_url: prUrl,
      decision,
      unmet: checks.unmet,
      notes,
      head_sha: commit.head,
      plan: result.plan ?? null,
      plan_text: result.planText,
    });
    if (update && existing) {
      return await reship(deps, input, {
        existing,
        wantAutoMerge,
        notes,
        ciFields,
        shippedNote,
        reportInput,
      });
    }
    const initialDecision: MergeDecisionKind = wantAutoMerge ? "auto_merge" : "draft";
    let pr: PullRequestRef;
    try {
      const body = maskWith(renderShipReport(config, reportInput(initialDecision, [])), secrets);
      try {
        pr = await github.createPullRequest({
          repo: job.repo,
          head: branch,
          base: defaultBranch,
          title,
          body,
          draft: !wantAutoMerge,
        });
      } catch (error) {
        if (!(error instanceof DraftUnavailableError)) throw error;
        notes.push("draft_unavailable");
        const retryBody = maskWith(renderShipReport(config, reportInput("draft", notes)), secrets);
        pr = await github.createPullRequest({
          repo: job.repo,
          head: branch,
          base: defaultBranch,
          title,
          body: retryBody,
          draft: false,
        });
      }
    } catch (error) {
      return await fail("ship_failed", maskWith(`PR を作れません: ${errorText(error)}`, secrets));
    }

    let decision: MergeDecisionKind = initialDecision;
    if (wantAutoMerge) {
      try {
        await github.enableAutoMerge({ repo: job.repo, nodeId: pr.nodeId });
      } catch (error) {
        notes.push(`auto_merge_failed: ${oneLine(maskWith(errorText(error), secrets))}`);
        try {
          await github.convertToDraft({ repo: job.repo, nodeId: pr.nodeId });
          decision = "draft";
        } catch (inner) {
          notes.push(`convert_to_draft_failed: ${oneLine(maskWith(errorText(inner), secrets))}`);
          decision = "unsettled";
        }
      }
    }

    // 振り分けが PR を作ったときから変わったら、本文を書き直す（本文の振り分けの文と実際をそろえる）
    if (decision !== initialDecision || notes.some((n) => !n.startsWith("draft_unavailable"))) {
      try {
        await github.updatePullRequestBody({
          repo: job.repo,
          number: pr.number,
          body: maskWith(renderShipReport(config, reportInput(decision, notes)), secrets),
        });
      } catch (error) {
        notes.push(`update_body_failed: ${maskWith(errorText(error), secrets)}`);
      }
    }

    // 状態（research R8）。PR を作ったあとは failed にしない。CI の待ちの列も同じトランザクションで書く（009）
    try {
      transitionPath(
        deps.db,
        job.id,
        ["judging", "pr_opened", "ci_waiting"],
        now(),
        { pr_number: pr.number },
        { pr_number: pr.number, base_sha: commit.base, ...ciFields },
      );
    } catch (error) {
      log.error({ err: error, pr: pr.number }, "PR を作ったあとの状態の遷移に失敗しました");
    }
    note(deps, job.id, "note", shippedNote(pr.number, pr.url, decision));
    log.info({ pr: pr.number, decision, unmet: checks.unmet, notes }, "PR を作りました");

    // Issue に知らせる（1回）
    try {
      const url = await github.createIssueComment({
        repo: job.repo,
        issueNumber: job.issue_number,
        body: maskWith(
          renderShipNotice({
            jobId: job.id,
            prUrl: pr.url,
            decision,
            unmet: checks.unmet,
            requests,
            autoMergeFailed: notes.some((n) => n.startsWith("auto_merge_failed: ")),
          }),
          secrets,
        ),
      });
      note(deps, job.id, "note", { kind: "ship_report_posted", comment_url: url });
    } catch (error) {
      const text = maskWith(errorText(error), secrets);
      note(deps, job.id, "error", { kind: "ship_report_failed", message: text });
      log.error({ error: text }, "出荷の知らせを投稿できませんでした");
    }
    return { kind: "shipped", prNumber: pr.number, prUrl: pr.url, decision };
  } catch (error) {
    log.error({ err: error }, "出荷の工程で想定外の例外");
    return await fail("internal_error", maskWith(errorText(error), secrets).split("\n")[0] ?? "");
  }
}

interface ReshipContext {
  existing: PullRequestState;
  wantAutoMerge: boolean;
  notes: string[];
  ciFields: TransitionFields;
  shippedNote: (prNumber: number, prUrl: string, decision: MergeDecisionKind) => object;
  reportInput: (
    decision: MergeDecisionKind,
    notes: readonly string[],
  ) => Parameters<typeof renderShipReport>[1];
}

/**
 * やり直しの push のあと（009 research R11）。振り分けは格下げだけ: auto-merge の PR が条件を外れたら Draft に変え、
 * Draft はそのまま。状態を ci_waiting に戻し、PR の本文を今回の結果で書き直す（CI の欄はそれまでの記録から）。
 * Issue にはコメントしない
 */
async function reship(deps: ShipDeps, input: ShipInput, ctx: ReshipContext): Promise<ShipOutcome> {
  const { github, config, logger } = deps;
  const { job, secrets } = input;
  const { existing, notes } = ctx;
  const log = logger.child({ jobId: job.id });
  const now = deps.now ?? Date.now;

  let decision: MergeDecisionKind;
  if (existing.draft) {
    decision = "draft";
  } else if (!existing.autoMerge) {
    // 008 で Draft を作れなかった・振り分けを確定できなかった PR。そのままにする
    decision = "unsettled";
  } else if (ctx.wantAutoMerge) {
    decision = "auto_merge";
  } else {
    try {
      await github.convertToDraft({ repo: job.repo, nodeId: existing.nodeId });
      decision = "draft";
    } catch (error) {
      notes.push(`convert_to_draft_failed: ${oneLine(maskWith(errorText(error), secrets))}`);
      decision = "unsettled";
    }
  }

  try {
    transitionPath(
      deps.db,
      job.id,
      ["judging", "pr_opened", "ci_waiting"],
      now(),
      { pr_number: existing.number, ci_retry: job.ci_retries },
      ctx.ciFields,
    );
  } catch (error) {
    log.error(
      { err: error, pr: existing.number },
      "やり直しの push のあとの状態の遷移に失敗しました",
    );
  }
  note(deps, job.id, "note", ctx.shippedNote(existing.number, existing.url, decision));
  note(deps, job.id, "note", {
    kind: "ci_retry_pushed",
    head_sha: ctx.ciFields.head_sha,
    ci_retry: job.ci_retries,
    decision,
    unmet: ctx.reportInput(decision, notes).unmet,
  });

  try {
    const body = renderShipReport(config, {
      ...ctx.reportInput(decision, notes),
      ciSection: renderCiSection(config, listCiEvents(deps.db, job.id)),
    });
    await github.updatePullRequestBody({
      repo: job.repo,
      number: existing.number,
      body: maskWith(body, secrets),
    });
  } catch (error) {
    const text = maskWith(errorText(error), secrets);
    note(deps, job.id, "error", { kind: "ci_body_failed", message: text });
    log.warn({ error: text }, "やり直しの PR の本文を書き直せませんでした");
  }
  log.info({ pr: existing.number, decision, ciRetry: job.ci_retries }, "やり直しを push しました");
  return { kind: "shipped", prNumber: existing.number, prUrl: existing.url, decision };
}
