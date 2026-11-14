import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { FakeGitHub } from "../github/testing.ts";
import { createLogger } from "../log.ts";
import {
  type Deployment,
  deployments,
  type JobStatus,
  jobEvents,
  jobs,
  llmCalls,
} from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import {
  FAILURE_KINDS,
  type FailureKind,
  failJob,
  listCiEvents,
  maskWith,
  postRollbackReport,
  pullRequestTitle,
  refreshDeploySection,
  renderCiSection,
  renderDeploySection,
  renderFailureReport,
  renderRevertPullRequest,
  renderRollbackReport,
  renderShipNotice,
  renderShipReport,
  replaceCiSection,
  replaceDeploySection,
  type ShipReportInput,
} from "./report.ts";
import type { PipelineResult } from "./run.ts";
import type { Condition } from "./ship-checks.ts";

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
  secret_detected:
    "変更に秘密情報らしい値が見つかった（または確かめられなかった）ため、push していません",
  unshippable_change: "CI の定義（`.github/workflows`）を変更したため、push していません",
  ship_failed: "commit・push・PR の作成に失敗しました",
  restarted: "ファクトリーの再起動で中断しました",
  stopped: "ファクトリーの停止で中断しました",
  internal_error: "内部エラーが起きました",
  ci_failed: "CI 失敗後のやり直しの上限（2 回）まで、CI が通りませんでした",
  ci_timeout: "CI の結論が 30 分以内に出ませんでした",
  ci_unfixed: "CI の失敗を受けたやり直しで、変更がありませんでした",
  pr_closed: "PR がマージされずに閉じられました",
  deploy_failed:
    "ステージングへのデプロイ（取得・ビルド）に失敗しました。ステージングは前の版のままです",
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
      kind: "judge_rejected",
      requests: 1,
      branch: "b",
      detail: "あ".repeat(3000),
    });
    expect(body).toContain("あ".repeat(2000));
    expect(body).not.toContain("あ".repeat(2001));
  });

  test("shipping_not_available はもうない（008 で出荷の工程に置き換えた）", () => {
    expect(FAILURE_KINDS as readonly string[]).not.toContain("shipping_not_available");
  });

  test("push 済みなら作業ブランチの行に「push 済み」", () => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "judging",
      kind: "ship_failed",
      requests: 1,
      branch: "agent/issue-7-job-3",
      pushed: true,
    });
    expect(body).toContain("| 作業ブランチ | `agent/issue-7-job-3`（push 済み） |");
  });

  test("secret_detected は見つかったファイル・行・規則を 20 件まで並べ、値を書かない", () => {
    const findings = Array.from({ length: 25 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i + 1,
      rule: "github-pat",
    }));
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "judging",
      kind: "secret_detected",
      requests: 1,
      branch: "b",
      conditions: [
        { name: "verdict", met: true, value: "pass" },
        { name: "secrets", met: false, value: { status: "found", findings } },
      ],
    });
    expect(body).toContain("- `src/f0.ts`:1（github-pat）");
    expect(body).toContain("- `src/f19.ts`:20（github-pat）");
    expect(body).not.toContain("src/f20.ts");
    expect(body).toContain("ほか 5 件");
  });

  test("スキャンできなかったときは理由を書く", () => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "judging",
      kind: "secret_detected",
      requests: 1,
      branch: "b",
      conditions: [
        { name: "secrets", met: false, value: { status: "unavailable", error: "gitleaks がない" } },
      ],
    });
    expect(body).toContain("秘密情報のスキャンを実行できませんでした: gitleaks がない");
  });

  test("unshippable_change は当たったパスを並べる", () => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "judging",
      kind: "unshippable_change",
      requests: 1,
      branch: "b",
      conditions: [
        {
          name: "forbidden_paths",
          met: false,
          value: {
            matched: [{ path: ".github/workflows/ci.yml", pattern: ".github/workflows/**" }],
          },
        },
      ],
    });
    expect(body).toContain("- `.github/workflows/ci.yml`");
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
    await failJob(deps, job, "ship_failed", "push できない");
    expect(db.select().from(jobs).get()?.status).toBe("failed");
    expect(github.comments[0]?.body).toContain("| 止まった工程 | judging |");
  });
});

const ALL_MET: Condition[] = [
  { name: "verdict", met: true, value: "pass" },
  { name: "diff_size", met: true, value: { lines: 4, max: 300 } },
  { name: "forbidden_paths", met: true, value: { matched: [] } },
  { name: "secrets", met: true, value: { status: "clean" } },
  { name: "skip_label", met: true, value: { label: "no-auto-merge", present: false } },
  { name: "work_type", met: true, value: { work_type: "docs", allowed: ["bugfix", "docs"] } },
];

function shipInput(extra: Partial<ShipReportInput> = {}): ShipReportInput {
  const result: PipelineResult = {
    outcome: "passed",
    plan: {
      summary: "README に検査の説明を足す",
      steps: ["直す"],
      acceptance_criteria: ["README に説明がある", "リンクが切れていない"],
      work_type: "docs",
    },
    planText: "",
    verdict: {
      verdict: "pass",
      reasons: "受け入れ条件をすべて満たす",
      criteria: [
        { criterion: "README に説明がある", met: true },
        { criterion: "リンクが切れていない", met: true },
      ],
    },
    reason: "",
    rounds: [
      {
        round: 1,
        implement: { outcome: "completed", turns: 3, requests: 3, runId: 1 },
        checks: { status: "passed", runs: 2, fedBack: 1 },
        verdict: "pass",
        diffStat: { files: 1, insertions: 3, deletions: 1 },
      },
    ],
    retries: 0,
    requests: 5,
    diff: "",
    diffStat: { files: 1, insertions: 3, deletions: 1 },
    tracePath: "/tmp/t.jsonl",
  };
  return {
    jobId: 3,
    issueNumber: 7,
    result,
    requests: 5,
    changes: { files: [{ path: "README.md" }], insertions: 3, deletions: 1 },
    conditions: ALL_MET,
    unmet: [],
    decision: "auto_merge",
    notes: [],
    ...extra,
  };
}

describe("renderShipReport（008）", () => {
  test("6条件の表・振り分け・計画・結果を書き、Issue を参照するが閉じない", () => {
    const body = renderShipReport(CONFIG, shipInput());
    expect(body).toContain("### 🏭 ファクトリー: ジョブ #3 のまとめ");
    expect(body).toContain("Refs #7");
    expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #7/i);
    expect(body).toContain("**自動マージ**: auto-merge（squash）を有効にしました");
    expect(body).toContain("| 検査役の判定 | ✅ | 合格 |");
    expect(body).toContain("| diff の大きさ | ✅ | 4 行 / 上限 300 行 |");
    expect(body).toContain("| 禁止パス | ✅ | なし |");
    expect(body).toContain("| 秘密情報のスキャン | ✅ | 見つかりませんでした |");
    expect(body).toContain("| `no-auto-merge` ラベル | ✅ | なし |");
    expect(body).toContain("| 作業の種類 | ✅ | `docs`（許可: `bugfix`, `docs`） |");
    expect(body).toContain("1. README に説明がある");
    expect(body).toContain("| 工程内テスト | 成功（2 回実行） |");
    expect(body).toContain("| 判定 | 合格。受け入れ条件 ✅ 2 / 2 |");
    expect(body).toContain("| やり直し | 0 回 |");
    expect(body).toContain("| 消費したリクエスト | 5 / 1ジョブの上限 10 |");
    expect(body).toContain("| 変更 | 1 ファイル（+3 −1） |");
    expect(body).toContain("- `README.md`");
  });

  test("Draft の文に満たさなかった条件と notes を書く", () => {
    const conditions: Condition[] = ALL_MET.map((c) =>
      c.name === "work_type"
        ? { name: "work_type", met: false, value: { work_type: "feature", allowed: ["docs"] } }
        : c,
    );
    const body = renderShipReport(
      CONFIG,
      shipInput({
        conditions,
        unmet: ["work_type"],
        decision: "draft",
        notes: ["auto_merge_failed: Pull request is in clean status", "draft_unavailable"],
      }),
    );
    expect(body).toContain(
      "Draft PR にしました。人間の確認を待ちます。満たさなかった条件: 作業の種類。",
    );
    expect(body).toContain("auto-merge を有効にできませんでした: Pull request is in clean status");
    expect(body).toContain("このリポジトリでは Draft PR を作れないため、通常の PR にしました");
    expect(body).toContain("| 作業の種類 | ❌ | `feature`（許可: `docs`） |");
  });

  test("unsettled の文", () => {
    const body = renderShipReport(
      CONFIG,
      shipInput({
        decision: "unsettled",
        notes: ["auto_merge_failed: x", "convert_to_draft_failed: y"],
      }),
    );
    expect(body).toContain("auto-merge を有効にできず、Draft にも変えられませんでした");
  });

  test("ファイルは 50 件まで、判定の理由は 2000 文字まで、本文は 60000 文字以下", () => {
    const input = shipInput({
      changes: {
        files: Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.ts` })),
        insertions: 1,
        deletions: 0,
      },
    });
    if (input.result.verdict) input.result.verdict.reasons = "理".repeat(3000);
    const body = renderShipReport(CONFIG, input);
    expect(body).toContain("- `f49.ts`");
    expect(body).not.toContain("- `f50.ts`");
    expect(body).toContain("- ほか 10 件");
    expect(body).toContain("理".repeat(2000));
    expect(body).not.toContain("理".repeat(2001));

    const huge = shipInput({
      changes: {
        files: Array.from({ length: 50 }, (_, i) => ({ path: `${"d/".repeat(600)}f${i}.ts` })),
        insertions: 1,
        deletions: 0,
      },
    });
    expect(renderShipReport(CONFIG, huge).length).toBeLessThanOrEqual(60000);
  });

  test("maskWith を通すと秘密情報らしい文字列が伏せ字になる", () => {
    const input = shipInput();
    if (input.result.verdict)
      input.result.verdict.reasons = "ghs_FakeInstallationToken0123456789abcd が見えた";
    const body = maskWith(renderShipReport(CONFIG, input), [
      "ghs_FakeInstallationToken0123456789abcd",
    ]);
    expect(body).not.toContain("ghs_FakeInstallationToken0123456789abcd");
    expect(body).toContain("[REDACTED]");
  });
});

describe("renderShipNotice・pullRequestTitle（008）", () => {
  test("Issue のコメントに PR へのリンクと振り分けを書く", () => {
    expect(
      renderShipNotice({
        jobId: 3,
        prUrl: "https://x/pull/1",
        decision: "auto_merge",
        unmet: [],
        requests: 5,
      }),
    ).toBe(
      "🏭 ジョブ #3 の変更を PR にしました: https://x/pull/1\n\n- 自動マージ: auto-merge を予約しました\n- 消費したリクエスト: 5",
    );
    expect(
      renderShipNotice({
        jobId: 3,
        prUrl: "u",
        decision: "draft",
        unmet: ["diff_size", "work_type"],
        requests: 5,
      }),
    ).toContain("Draft にしました（満たさなかった条件: diff_size, work_type）");
  });

  test("PR の題は計画の概要の1行目を 72 文字で切り詰める。計画がなければ Issue の番号", () => {
    const plan = {
      summary: "README を直す\n詳細",
      steps: ["a"],
      acceptance_criteria: ["b"],
      work_type: "docs" as const,
    };
    expect(pullRequestTitle(plan, 7)).toBe("README を直す");
    const long = { ...plan, summary: "あ".repeat(100) };
    expect(Array.from(pullRequestTitle(long, 7))).toHaveLength(72);
    expect(pullRequestTitle(undefined, 7)).toBe("Issue #7 への対応");
  });
});

// ---- 009 ----

describe("renderFailureReport の CI の行（009）", () => {
  test("PR があれば PR とやり直しの回数、失敗したチェックを 10 件まで並べる", () => {
    const body = renderFailureReport(CONFIG, {
      jobId: 3,
      stage: "ci_waiting",
      kind: "ci_failed",
      requests: 4,
      branch: "b",
      pr: { number: 12, ciRetries: 2 },
      failedChecks: Array.from({ length: 12 }, (_, i) => ({
        name: `job-${i}`,
        conclusion: "failure",
      })),
    });
    expect(body).toContain("| PR | #12 |");
    expect(body).toContain("| CI のやり直し | 2 / 上限 2 |");
    expect(body).toContain("失敗したチェック:\n- `job-0`（failure）");
    expect(body).toContain("- `job-9`（failure）");
    expect(body).not.toContain("job-10");
    expect(body).toContain("- ほか 2 件");
  });
});

function noteRow(kind: string, detail: object, id: number) {
  return {
    id,
    job_id: 1,
    type: "note" as const,
    from_status: null,
    to_status: null,
    detail: JSON.stringify({ kind, ...detail }),
    created_at: id,
  };
}

describe("renderCiSection・replaceCiSection（009）", () => {
  test("記録がなければ「待っています」", () => {
    expect(renderCiSection(CONFIG, [])).toBe(
      "<!-- factory:ci -->\n#### CI\nCI の結果を待っています\n<!-- /factory:ci -->",
    );
  });

  test("失敗・やり直し・通過・マージ・諦めの行を順に書く", () => {
    const section = renderCiSection(CONFIG, [
      noteRow(
        "ci_result",
        {
          head_sha: "abcdef1234567",
          conclusion: "failure",
          attempt: 1,
          failed: [
            { name: "test", conclusion: "failure" },
            { name: "lint", conclusion: "timed_out" },
          ],
        },
        1,
      ),
      noteRow("ci_event", { event: "check_suite" }, 2),
      noteRow(
        "ci_retry_pushed",
        { head_sha: "1234567abc", ci_retry: 1, decision: "auto_merge" },
        3,
      ),
      noteRow(
        "ci_result",
        { head_sha: "1234567abc", conclusion: "success", attempt: 2, failed: [] },
        4,
      ),
      noteRow("merged", { pr_number: 3 }, 5),
      noteRow("ci_gave_up", { reason: "ci_timeout", converted_to_draft: true }, 6),
    ]);
    expect(section.split("\n")).toEqual([
      "<!-- factory:ci -->",
      "#### CI",
      "| # | commit | 結果 | 内容 |",
      "|---|---|---|---|",
      "| 1 | `abcdef1` | ❌ 失敗 | `test`（failure）、`lint`（timed_out） |",
      "| — | `1234567` | 🔁 やり直しを push | CI 失敗後のやり直し 1 / 2。自動マージ: auto-merge のまま |",
      "| 2 | `1234567` | ✅ 通過 | |",
      "| — | | 🎉 マージ | |",
      "| — | | ⌛ CI 待ちの時間切れ（30 分） | 理由: `ci_timeout`。Draft にしました。人間の確認を待ちます |",
      "<!-- /factory:ci -->",
    ]);
  });

  test("欄があれば置き換え、008 の印があればそこに、なければ末尾に足す", () => {
    const section = "<!-- factory:ci -->\nNEW\n<!-- /factory:ci -->";
    expect(replaceCiSection("A\n<!-- factory:ci -->\nOLD\n<!-- /factory:ci -->\nB", section)).toBe(
      `A\n${section}\nB`,
    );
    expect(
      replaceCiSection(
        "A\n<!-- 009・010 で CI・マージ・デプロイの結果をここに書き足す -->",
        section,
      ),
    ).toBe(`A\n${section}`);
    expect(replaceCiSection("A\n\n", section)).toBe(`A\n\n${section}`);
  });

  test("まとめレポートの末尾は空の CI の欄", () => {
    const body = renderShipReport(CONFIG, shipInput());
    expect(body).toContain(
      "<!-- factory:ci -->\n#### CI\nCI の結果を待っています\n<!-- /factory:ci -->",
    );
    expect(body).not.toContain("009・010 で");
  });
});

describe("failJob の引き渡し（009）", () => {
  function withPr(draft: boolean, state: "open" | "closed" = "open", autoMerge = true) {
    const ctx = setup("ci_waiting");
    ctx.db.update(jobs).set({ pr_number: 5, ci_retries: 1 }).run();
    ctx.github.addPullRequest({
      number: 5,
      repo: "octo-org/demo",
      draft,
      state,
      autoMerge,
      body: "まとめ\n<!-- factory:ci -->\n#### CI\nCI の結果を待っています\n<!-- /factory:ci -->",
    });
    return ctx;
  }

  test("報告のあとに PR を Draft に変え、ci_gave_up を記録し、CI の欄を書き直す", async () => {
    const { db, deps, github, job } = withPr(false);
    await failJob(deps, job, "ci_failed", "上限", {
      failedChecks: [{ name: "test", conclusion: "failure" }],
    });
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.body).toContain("| PR | #5 |");
    expect(github.comments[0]?.body).toContain("| CI のやり直し | 1 / 上限 2 |");
    expect(github.comments[0]?.body).toContain("- `test`（failure）");
    expect(github.pullRequests[0]?.draft).toBe(true);
    expect(github.pullRequests[0]?.body).toContain("🛑 ファクトリーは作業を止めました");
    expect(github.pullRequests[0]?.body).toContain("Draft にしました");
    expect(github.pullRequests[0]?.body.startsWith("まとめ\n")).toBe(true);
    const gaveUp = listCiEvents(db, job.id).map((e) => JSON.parse(e.detail ?? "{}"));
    expect(gaveUp).toEqual([{ kind: "ci_gave_up", reason: "ci_failed", converted_to_draft: true }]);
  });

  test("すでに Draft なら変えない。auto-merge でもない通常の PR（unsettled）は Draft に変える", async () => {
    const draft = withPr(true);
    await failJob(draft.deps, draft.job, "ci_timeout", "時間切れ");
    expect(draft.github.count("convertToDraft")).toBe(0);
    const unsettled = withPr(false, "open", false);
    await failJob(unsettled.deps, unsettled.job, "judge_rejected", "不合格");
    expect(unsettled.github.count("convertToDraft")).toBe(1);
  });

  test("pr_closed では Draft に変えない", async () => {
    const { deps, github, job } = withPr(false, "closed");
    await failJob(deps, job, "pr_closed", "閉じた");
    expect(github.count("getPullRequest")).toBe(0);
    expect(github.count("convertToDraft")).toBe(0);
  });

  test("Draft への変更の失敗は handover_failed に残り、ジョブは failed のまま", async () => {
    const ctx = withPr(false);
    ctx.github.options.fail = { convertToDraft: new Error("GraphQL error") };
    await failJob(ctx.deps, ctx.job, "ci_failed", "上限");
    expect(ctx.db.select().from(jobs).get()?.status).toBe("failed");
    const errors = ctx.db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.type === "error")
      .map((e) => JSON.parse(e.detail ?? "{}").kind);
    expect(errors).toEqual(["handover_failed"]);
    expect(ctx.github.pullRequests[0]?.body).toContain("Draft に変えられませんでした");
  });
});

describe("failJob のデプロイの失敗（010）", () => {
  test.each(["merged", "deploying"] as const)(
    "%s から失敗したジョブは PR を Draft に変えない",
    async (status) => {
      const ctx = setup(status);
      ctx.db.update(jobs).set({ pr_number: 5 }).run();
      ctx.github.addPullRequest({
        number: 5,
        repo: "octo-org/demo",
        state: "closed",
        merged: true,
      });
      await failJob(ctx.deps, ctx.job, "deploy_failed", "ビルドに失敗しました");
      expect(ctx.db.select().from(jobs).get()?.status).toBe("failed");
      expect(ctx.github.count("getPullRequest")).toBe(0);
      expect(ctx.github.count("convertToDraft")).toBe(0);
      expect(ctx.github.comments[0]?.body).toContain(
        "ステージングへのデプロイ（取得・ビルド）に失敗しました",
      );
      expect(ctx.github.comments[0]?.body).toContain("`deploy_failed`");
    },
  );
});

describe("デプロイの欄（010 contracts/report.md 1章）", () => {
  const A = "a".repeat(40);
  const row = (overrides: Partial<Deployment>): Deployment => ({
    id: 1,
    repo: "octo-org/demo",
    job_id: 1,
    commit_sha: A,
    before_sha: "b".repeat(40),
    image_tag: "app:aaaaaaaaaaaa",
    status: "succeeded",
    failed_stage: null,
    rolled_back: false,
    rolled_back_to: null,
    rollback_healthy: null,
    revert_pr_number: null,
    error: null,
    created_at: 1,
    started_at: 1,
    finished_at: 2,
    ...overrides,
  });
  const withUrl = parseConfig(
    `[llm]\nbase_url = "https://x.test/v1"\n[models]\nplanner = "p"\nimplementer = "i"\nverifier = "v"\nfallback = "f"\n[budget]\nmonthly_requests = 10\nper_job_requests = 5\n[github]\nallowed_users = ["u"]\n[staging]\npublic_url = "https://staging.example.jp"\n`,
    "/srv",
  );

  test("各状態の行", () => {
    const section = renderDeploySection(CONFIG, [
      row({ id: 1, status: "running" }),
      row({ id: 2 }),
      row({ id: 3, status: "failed", failed_stage: "build" }),
      row({
        id: 4,
        status: "failed",
        failed_stage: "health",
        rolled_back: true,
        rolled_back_to: "app:old",
        rollback_healthy: true,
        revert_pr_number: 9,
      }),
      row({
        id: 5,
        status: "failed",
        failed_stage: "release",
        rolled_back: true,
        error: "衝突しました",
      }),
      row({ id: 6, status: "failed", failed_stage: "interrupted" }),
    ]);
    expect(section.split("\n")).toEqual([
      "<!-- factory:deploy -->",
      "#### ステージング",
      "| commit | イメージ | 結果 | 内容 |",
      "|---|---|---|---|",
      "| `aaaaaaa` | `app:aaaaaaaaaaaa` | ⏳ デプロイ中 | |",
      "| `aaaaaaa` | `app:aaaaaaaaaaaa` | ✅ デプロイしました | ステージングで動いています |",
      "| `aaaaaaa` | `app:aaaaaaaaaaaa` | ❌ ビルドに失敗しました | ステージングは前の版のままです |",
      "| `aaaaaaa` | `app:aaaaaaaaaaaa` | ↩️ 戻しました | ヘルスチェックが通りませんでした。`app:old` に戻しました（戻した版のヘルスチェック: 通過）。revert PR #9 |",
      "| `aaaaaaa` | `app:aaaaaaaaaaaa` | ↩️ 戻しました | 入れ替えに失敗しました。ステージングを止めました。revert PR は作りませんでした（衝突しました） |",
      "| `aaaaaaa` | `app:aaaaaaaaaaaa` | 🛑 中断しました | |",
      "<!-- /factory:deploy -->",
    ]);
  });

  test("public_url があれば成功の行に出す", () => {
    expect(renderDeploySection(withUrl, [row({})])).toContain("| https://staging.example.jp |");
  });

  test("置き換え・CI の欄の後ろに入れる・末尾に足す", () => {
    const section = renderDeploySection(CONFIG, [row({})]);
    const ci = "<!-- factory:ci -->\n#### CI\nx\n<!-- /factory:ci -->";
    expect(replaceDeploySection(`まとめ\n${ci}\n\n末尾`, section)).toBe(
      `まとめ\n${ci}\n\n${section}\n\n末尾`,
    );
    const once = replaceDeploySection(`まとめ\n${ci}`, renderDeploySection(CONFIG, []));
    expect(replaceDeploySection(once, section)).toBe(`まとめ\n${ci}\n\n${section}`);
    expect(replaceDeploySection("まとめ\n\n", section)).toBe(`まとめ\n\n${section}`);
  });

  test("refreshDeploySection は deployments から作り直して書き、失敗は deploy_body_failed", async () => {
    const ctx = setup("deploying");
    ctx.db.update(jobs).set({ pr_number: 5 }).run();
    ctx.github.addPullRequest({ number: 5, body: "まとめ" });
    ctx.db
      .insert(deployments)
      .values({
        repo: "octo-org/demo",
        job_id: ctx.job.id,
        commit_sha: A,
        image_tag: "app:aaaaaaaaaaaa",
        status: "succeeded",
        created_at: 1,
      })
      .run();
    const job = ctx.db.select().from(jobs).get();
    if (!job) throw new Error("no job");
    await refreshDeploySection(ctx.deps, job);
    expect(ctx.github.pullRequests[0]?.body).toContain("✅ デプロイしました");
    ctx.github.options.fail = { updatePullRequestBody: new Error("boom") };
    ctx.db.update(deployments).set({ status: "failed", failed_stage: "build" }).run();
    await refreshDeploySection(ctx.deps, job);
    const errors = ctx.db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.type === "error")
      .map((e) => JSON.parse(e.detail ?? "{}").kind);
    expect(errors).toEqual(["deploy_body_failed"]);
  });
});

describe("ロールバックの報告と revert PR（010 contracts/report.md 2・3章）", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const failed = (overrides: Partial<Deployment> = {}): Deployment => ({
    id: 1,
    repo: "octo-org/demo",
    job_id: 1,
    commit_sha: A,
    before_sha: B,
    image_tag: "app:aaaaaaaaaaaa",
    status: "failed",
    failed_stage: "health",
    rolled_back: true,
    rolled_back_to: "app:0123456789ab",
    rollback_healthy: true,
    revert_pr_number: 35,
    error: null,
    created_at: 1,
    started_at: 1,
    finished_at: 2,
    ...overrides,
  });
  const health = { healthy: false, attempts: 30, last: "500" };

  test("報告: 戻し先あり・revert PR あり", () => {
    expect(
      renderRollbackReport({ jobId: 12, prNumber: 34, deployment: failed(), health }).split("\n"),
    ).toEqual([
      "### 🏭 ファクトリー: ジョブ #12 の変更をステージングから戻しました",
      "",
      "| 項目 | 内容 |",
      "|---|---|",
      "| PR | #34 |",
      "| commit | `aaaaaaa` |",
      "| 失敗 | ヘルスチェックが通りませんでした |",
      "| ヘルスチェック | 30 回試して通りませんでした（最後: 500） |",
      "| 戻し先 | `app:0123456789ab`（戻した版のヘルスチェック: 通過） |",
      "| revert PR | #35（auto-merge は有効にしていません。確かめてからマージしてください） |",
    ]);
  });

  test("報告: 戻し先なし・戻した版が不健康・revert PR を作らなかった", () => {
    const stopped = renderRollbackReport({
      jobId: 12,
      prNumber: null,
      deployment: failed({
        rolled_back_to: null,
        rollback_healthy: null,
        revert_pr_number: null,
        error: "conflict",
      }),
      health,
    });
    expect(stopped).toContain("| 戻し先 | なし（ステージングを止めました） |");
    expect(stopped).toContain("| revert PR | 作りませんでした（conflict） |");
    expect(stopped).not.toContain("| PR |");
    const unhealthy = renderRollbackReport({
      jobId: 1,
      prNumber: 2,
      deployment: failed({ rollback_healthy: false, failed_stage: "release" }),
    });
    expect(unhealthy).toContain("戻した版のヘルスチェック: 失敗");
    expect(unhealthy).toContain("| 失敗 | ステージングの入れ替えに失敗しました |");
    expect(unhealthy).toContain("| ヘルスチェック | 入れ替えに失敗したため確かめていません |");
  });

  test("revert PR の題と本文", () => {
    const { title, body } = renderRevertPullRequest({
      deployment: failed(),
      prNumber: 34,
      health,
      rolledBackTo: "app:0123456789ab",
    });
    expect(title).toBe("Revert aaaaaaa（ステージングのヘルスチェックの失敗）");
    expect(body).toContain("`aaaaaaa`（PR #34）をデプロイしたところ");
    expect(body).toContain("`bbbbbbb..aaaaaaa` の変更を打ち消します");
    expect(body).toContain("| 戻し先 | `app:0123456789ab` |");
    expect(body).toContain("auto-merge は有効にしていません");
  });

  test("postRollbackReport は1回だけ投稿し、失敗は report_failed", async () => {
    const ctx = setup("rolled_back");
    const job = ctx.db.select().from(jobs).get();
    if (!job) throw new Error("no job");
    await postRollbackReport(ctx.deps, job, { deployment: failed(), health });
    await postRollbackReport(ctx.deps, job, { deployment: failed(), health });
    expect(ctx.github.comments).toHaveLength(1);
    const other = setup("rolled_back");
    other.github.options.fail = { createIssueComment: new Error("down") };
    const otherJob = other.db.select().from(jobs).get();
    if (!otherJob) throw new Error("no job");
    await postRollbackReport(other.deps, otherJob, { deployment: failed(), health });
    const kinds = other.db
      .select()
      .from(jobEvents)
      .all()
      .map((e) => JSON.parse(e.detail ?? "{}").kind);
    expect(kinds).toEqual(["report_failed"]);
  });
});
