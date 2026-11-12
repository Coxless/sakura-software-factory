import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { FakeGitHub } from "../github/testing.ts";
import { createLogger } from "../log.ts";
import { type JobStatus, jobEvents, jobs, llmCalls } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { FAILURE_KINDS, type FailureKind, failJob, renderFailureReport } from "./report.ts";

const CONFIG = parseConfig(
  `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"
[models]
planner = "p"
implementer = "i"
verifier = "v"
fallback = "f"
[budget]
monthly_requests = 100
per_job_requests = 10
[limits]
judge_retries = 2
job_timeout_minutes = 45
[github]
allowed_users = ["octo-requester"]
`,
  "/srv/factory",
);

function setup(status: JobStatus = "implementing", options: { failComment?: boolean } = {}) {
  const handle = migratedMemoryDb();
  const lines: string[] = [];
  const logger = createLogger(
    { level: "info" },
    new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  );
  const github = new FakeGitHub(
    options.failComment ? { fail: { createIssueComment: new Error("502 Bad Gateway") } } : {},
  );
  const job = handle.db
    .insert(jobs)
    .values({
      repo: "octo-org/demo",
      issue_number: 7,
      trigger_comment_id: 1,
      requested_by: "octo-requester",
      instruction: "直して",
      status,
      branch: status === "planning" ? null : "agent/issue-7-job-1",
      created_at: 1,
      updated_at: 1,
    })
    .returning()
    .get();
  const deps = { db: handle.db, config: CONFIG, logger, github, now: () => 1000 };
  return { ...handle, deps, github, job, logs: () => lines.join("") };
}

const DESCRIPTIONS: Record<FailureKind, string> = {
  clone_failed: "Issue またはリポジトリを取得できませんでした",
  install_failed: "依存のインストールに失敗しました",
  pipeline_failed: "計画から判定までの工程が失敗しました",
  judge_rejected: "やり直しの上限（2 回）まで、判定に合格しませんでした",
  budget_exceeded: "リクエストの予算に達しました",
  timeout: "ジョブの時間の上限（45 分）を超えました",
  shipping_not_available: "判定には合格しましたが、PR を作る工程はまだありません",
  restarted: "ファクトリーの再起動で中断しました",
  stopped: "ファクトリーの停止で中断しました",
  internal_error: "内部エラーが起きました",
};

describe("renderFailureReport", () => {
  test.each(FAILURE_KINDS)("%s の説明の文が入る", (kind) => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "implementing",
      kind,
      requests: 4,
      branch: "agent/issue-7-job-3",
    });
    expect(body).toContain("### 🏭 ファクトリー: ジョブ #3 は完了しませんでした");
    expect(body).toContain(`| 理由 | ${DESCRIPTIONS[kind]}（\`${kind}\`） |`);
    expect(body).toContain("| 止まった工程 | implementing |");
    expect(body).toContain("| 消費したリクエスト | 4 / 1ジョブの上限 10 |");
    expect(body).toContain("| 作業ブランチ | `agent/issue-7-job-3`（push していません） |");
    expect(body).not.toContain("やり直し・変更");
  });

  test("準備で止まったら「準備」、ブランチがなければ「なし」", () => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "prepare",
      kind: "clone_failed",
      requests: 0,
      branch: null,
    });
    expect(body).toContain("| 止まった工程 | 準備 |");
    expect(body).toContain("| 作業ブランチ | なし |");
  });

  test("005 の結果があれば、やり直しの回数と diff の数の行が入る", () => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "judging",
      kind: "judge_rejected",
      requests: 9,
      branch: "b",
      result: { retries: 2, diffStat: { files: 3, insertions: 10, deletions: 4 } },
    });
    expect(body).toContain("| やり直し・変更 | 2 回 / 3 ファイル（+10 −4） |");
  });

  test("詳細は 2000 文字で切り詰める", () => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "judging",
      kind: "shipping_not_available",
      requests: 1,
      branch: "b",
      detail: "あ".repeat(3000),
    });
    expect(body).toContain("あ".repeat(2000));
    expect(body).not.toContain("あ".repeat(2001));
  });
});

describe("failJob", () => {
  test("failed にして、Issue に1回だけ報告し、report_posted を残す", async () => {
    const { db, deps, github, job } = setup();
    db.insert(llmCalls)
      .values(
        Array.from({ length: 3 }, () => ({
          job_id: job.id,
          phase: "implement",
          role: "implementer" as const,
          model: "i",
          attempt: 1,
          latency_ms: 1,
          status: "ok" as const,
          created_at: 1,
        })),
      )
      .run();
    await failJob(deps, job, "pipeline_failed", "計画の形が合いません", { detail: "詳しい理由" });
    await failJob(deps, job, "pipeline_failed", "2回目");

    const updated = db.select().from(jobs).get();
    expect(updated).toMatchObject({
      status: "failed",
      failure_reason: "pipeline_failed: 計画の形が合いません",
      finished_at: 1000,
    });
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toMatchObject({ repo: "octo-org/demo", issueNumber: 7 });
    expect(github.comments[0]?.body).toContain("| 止まった工程 | implementing |");
    expect(github.comments[0]?.body).toContain("| 消費したリクエスト | 3 / 1ジョブの上限 10 |");
    expect(github.comments[0]?.body).toContain("詳しい理由");
    const notes = db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.type === "note");
    expect(notes).toHaveLength(1);
    expect(JSON.parse(notes[0]?.detail ?? "{}")).toEqual({
      kind: "report_posted",
      comment_url: "https://github.com/octo-org/demo/issues/7#issuecomment-1",
    });
  });

  test("トークン・PEM・渡した秘密の値は伏せ字になる", async () => {
    const { db, deps, github, job } = setup();
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    await failJob(deps, job, "clone_failed", "fatal: ghp_abcdefghijklmnopqrstuvwxyz0123", {
      detail: `${pem}\nsecret-value-123`,
      secrets: ["secret-value-123"],
      stage: "prepare",
    });
    const body = github.comments[0]?.body ?? "";
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(body).not.toContain("MIIabc");
    expect(body).not.toContain("secret-value-123");
    expect(body).toContain("[REDACTED]");
    expect(body).toContain("| 止まった工程 | 準備 |");
    expect(db.select().from(jobs).get()?.failure_reason).toBe("clone_failed: fatal: [REDACTED]");
  });

  test("投稿に失敗してもジョブは failed のまま、report_failed を残し、例外を投げない", async () => {
    const { db, deps, job, logs } = setup("testing", { failComment: true });
    await expect(failJob(deps, job, "timeout", "時間切れ")).resolves.toBeUndefined();
    expect(db.select().from(jobs).get()?.status).toBe("failed");
    const events = db.select().from(jobEvents).all();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        detail: expect.stringContaining('"kind":"report_failed"'),
      }),
    );
    expect(logs()).toContain("報告");
  });

  test("終わりの状態のジョブには何もしない", async () => {
    const { db, deps, github, job } = setup("failed");
    await failJob(deps, job, "internal_error", "x");
    expect(github.comments).toEqual([]);
    expect(db.select().from(jobEvents).all()).toEqual([]);
  });

  test("渡したジョブの状態が古くても、DB の今の状態から failed にする", async () => {
    const { db, deps, github, job } = setup("planning");
    db.update(jobs).set({ status: "judging" }).run();
    await failJob(deps, job, "shipping_not_available", "合格");
    expect(db.select().from(jobs).get()?.status).toBe("failed");
    expect(github.comments[0]?.body).toContain("| 止まった工程 | judging |");
  });
});
