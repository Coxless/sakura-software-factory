import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { type FactoryConfig, parseConfig } from "../config.ts";
import { cloneForJob } from "../github/git.ts";
import { createBareRepo, FakeGitHub, type FakeGitHubOptions } from "../github/testing.ts";
import { createLogger } from "../log.ts";
import { type Job, jobEvents, jobs, llmCalls } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import type { PipelineResult } from "./run.ts";
import { type ShipInput, shipJob } from "./ship.ts";

const TOKEN = "ghs_FakeInstallationToken0123456789abcd";

function config(extra = ""): FactoryConfig {
  return parseConfig(
    `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"
[models]
planner = "p"
implementer = "i"
verifier = "v"
fallback = "f"
[budget]
monthly_requests = 1000
per_job_requests = 10
[github]
allowed_users = ["octo-requester"]
${extra}
`,
    "/srv/factory",
  );
}

/** 本物の形の偽の GitHub トークン（ソースに固定の値を書かない） */
function fakeGithubToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return `ghp_${Array.from(randomBytes(36), (b) => alphabet[b % alphabet.length]).join("")}`;
}

function passed(extra: Partial<PipelineResult> = {}): PipelineResult {
  return {
    outcome: "passed",
    plan: {
      summary: "README に検査の説明を足す",
      steps: ["README を直す"],
      acceptance_criteria: ["README に pnpm run check の説明がある"],
      work_type: "docs",
    },
    planText: "",
    verdict: {
      verdict: "pass",
      reasons: "受け入れ条件をすべて満たす",
      criteria: [{ criterion: "README に pnpm run check の説明がある", met: true }],
    },
    reason: "受け入れ条件をすべて満たす",
    rounds: [],
    retries: 0,
    requests: 3,
    diff: "",
    diffStat: { files: 1, insertions: 2, deletions: 0 },
    tracePath: "/tmp/trace.jsonl",
    ...extra,
  };
}

interface SetupOptions {
  github?: FakeGitHubOptions;
  configExtra?: string;
  files?: Record<string, string>;
}

async function setup(options: SetupOptions = {}) {
  const { baseUrl, root } = await createBareRepo();
  const bare = join(root, "octo-org", "demo.git");
  const handle = migratedMemoryDb();
  const lines: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    }),
  );
  const github = new FakeGitHub({ token: TOKEN, ...options.github });
  const job = handle.db
    .insert(jobs)
    .values({
      repo: "octo-org/demo",
      issue_number: 7,
      trigger_comment_id: 1,
      requested_by: "octo-requester",
      instruction: "README を直して",
      status: "judging",
      branch: "agent/issue-7-job-1",
      created_at: 1,
      updated_at: 1,
      started_at: 1,
    })
    .returning()
    .get();
  const workdir = join(root, "work", "job-1", "repo");
  await cloneForJob({
    repo: "octo-org/demo",
    token: TOKEN,
    defaultBranch: "main",
    dir: workdir,
    branch: "agent/issue-7-job-1",
    baseUrl,
  });
  const files = options.files ?? { "README.md": "# demo\n\n`pnpm run check` で検査する\n" };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workdir, path)), { recursive: true });
    writeFileSync(join(workdir, path), content);
  }
  const deps = {
    db: handle.db,
    config: config(options.configExtra),
    logger,
    github,
    cloneBaseUrl: baseUrl,
    now: () => 1000,
  };
  const input = (extra: Partial<ShipInput> = {}): ShipInput => ({
    job,
    workdir,
    branch: "agent/issue-7-job-1",
    issue: { title: "README を直す" },
    result: passed(),
    interruption: () => undefined,
    secrets: [],
    ...extra,
  });
  const remoteBranch = async () => {
    const r = await execa(
      "git",
      ["-C", bare, "rev-parse", "--verify", "--quiet", "refs/heads/agent/issue-7-job-1"],
      {
        reject: false,
      },
    );
    return r.exitCode === 0 ? r.stdout.trim() : undefined;
  };
  const jobRow = () => handle.db.select().from(jobs).get() as Job;
  const events = () => handle.db.select().from(jobEvents).all();
  const notes = (kind: string) =>
    events()
      .filter((e) => e.detail?.includes(`"kind":"${kind}"`))
      .map((e) => JSON.parse(e.detail ?? "{}") as Record<string, unknown>);
  return {
    ...handle,
    deps,
    github,
    input,
    bare,
    workdir,
    remoteBranch,
    jobRow,
    events,
    notes,
    logs: () => lines.join(""),
  };
}

describe("shipJob: auto-merge と Draft", () => {
  test("6条件を満たせば通常の PR と auto-merge。状態は ci_waiting、pr_number が入る", async () => {
    const s = await setup();
    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({
      kind: "shipped",
      prNumber: 1,
      prUrl: "https://github.com/octo-org/demo/pull/1",
      decision: "auto_merge",
    });
    const head = await s.remoteBranch();
    expect(head).toBeDefined();
    const count = await execa("git", ["-C", s.bare, "rev-list", "--count", `main..${head}`]);
    expect(count.stdout).toBe("1");
    const author = await execa("git", ["-C", s.bare, "log", "-1", "--format=%an", head ?? ""]);
    expect(author.stdout).toBe("factory-app[bot]");

    const pr = s.github.pullRequests[0];
    expect(pr).toMatchObject({
      head: "agent/issue-7-job-1",
      base: "main",
      draft: false,
      autoMerge: true,
      title: "README に検査の説明を足す",
    });
    expect(pr?.body).toContain("Refs #7");
    expect(pr?.body).toContain("auto-merge（squash）を有効にしました");
    expect(s.github.count("updatePullRequestBody")).toBe(0);
    expect(pr?.body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #7/i);

    const job = s.jobRow();
    expect(job.status).toBe("ci_waiting");
    expect(job.pr_number).toBe(1);
    const transitions = s.events().filter((e) => e.type === "state_changed");
    expect(transitions.map((e) => [e.from_status, e.to_status])).toEqual([
      ["judging", "pr_opened"],
      ["pr_opened", "ci_waiting"],
    ]);
    expect(s.notes("ship_checks")).toHaveLength(1);
    expect(s.notes("shipped")[0]).toMatchObject({
      pr_number: 1,
      decision: "auto_merge",
      unmet: [],
      plan: { work_type: "docs" },
      plan_text: "",
    });
  });

  test("CI の待ちの列（base_sha・head_sha・ci_status・ci_deadline）を書き、本文に空の CI の欄（009）", async () => {
    const s = await setup();
    await shipJob(s.deps, s.input());
    const main = await execa("git", ["-C", s.bare, "rev-parse", "main"]);
    expect(s.jobRow()).toMatchObject({
      base_sha: main.stdout.trim(),
      head_sha: await s.remoteBranch(),
      ci_status: "pending",
      ci_deadline: 1000 + 30 * 60_000,
      ci_event_at: null,
    });
    expect(s.github.pullRequests[0]?.body).toContain("<!-- factory:ci -->");
  });

  test("作業の種類が許可にないと Draft で、auto-merge は呼ばない", async () => {
    const s = await setup();
    const result = passed();
    if (result.plan) result.plan.work_type = "feature";
    const out = await shipJob(s.deps, s.input({ result }));
    expect(out).toMatchObject({ kind: "shipped", decision: "draft" });
    expect(s.github.pullRequests[0]?.draft).toBe(true);
    expect(s.github.count("enableAutoMerge")).toBe(0);
    expect(s.notes("shipped")[0]).toMatchObject({ decision: "draft", unmet: ["work_type"] });
  });

  test("auto-merge を有効にできなければ Draft に変え、理由を notes に残す", async () => {
    const s = await setup({
      github: {
        fail: {
          enableAutoMerge: new Error(
            "Request failed due to following response errors:\n - Pull request is in clean status",
          ),
        },
      },
    });
    const out = await shipJob(s.deps, s.input());
    expect(out).toMatchObject({ kind: "shipped", decision: "draft" });
    expect(s.github.count("convertToDraft")).toBe(1);
    expect(s.github.pullRequests[0]?.draft).toBe(true);
    const shipped = s.notes("shipped")[0];
    expect(shipped?.notes).toEqual([
      "auto_merge_failed: Request failed due to following response errors: - Pull request is in clean status",
    ]);
    // PR の本文と Issue の知らせが、実際の振り分け（Draft）と理由に書き直されている
    const body = s.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("Draft PR にしました");
    expect(body).toContain(
      "auto-merge を有効にできませんでした: Request failed due to following response errors: - Pull request is in clean status",
    );
    expect(body).not.toContain("auto-merge（squash）を有効にしました");
    expect(s.github.comments[0]?.body).toContain("auto-merge を有効にできませんでした");
  });

  test("auto-merge も Draft への変更も失敗したら unsettled で、ci_waiting に進む", async () => {
    const s = await setup({
      github: {
        fail: {
          enableAutoMerge: new Error("no auto-merge"),
          convertToDraft: new Error("no draft"),
        },
      },
    });
    const out = await shipJob(s.deps, s.input());
    expect(out).toMatchObject({ kind: "shipped", decision: "unsettled" });
    expect(s.jobRow().status).toBe("ci_waiting");
  });

  test("Draft を作れないリポジトリでは通常の PR で作り直し、auto-merge は呼ばない", async () => {
    const s = await setup({ github: { draftUnavailable: true } });
    const result = passed();
    if (result.plan) result.plan.work_type = "feature";
    const out = await shipJob(s.deps, s.input({ result }));
    expect(out).toMatchObject({ kind: "shipped", decision: "draft" });
    expect(s.github.count("createPullRequest")).toBe(2);
    expect(s.github.pullRequests).toHaveLength(1);
    expect(s.github.pullRequests[0]?.draft).toBe(false);
    expect(s.github.count("enableAutoMerge")).toBe(0);
    expect(s.notes("shipped")[0]?.notes).toEqual(["draft_unavailable"]);
  });

  test("ラベルは PR を作る直前に取り直す", async () => {
    const s = await setup();
    // 準備のときにはなかったラベルが、出荷の時点で付いている
    s.github.options.issue = { title: "t", body: "b", labels: ["no-auto-merge"] };
    const out = await shipJob(s.deps, s.input());
    expect(out).toMatchObject({ decision: "draft" });
    expect(s.notes("shipped")[0]).toMatchObject({ unmet: ["skip_label"] });
  });
});

describe("shipJob: push しない", () => {
  test("秘密情報があれば push も PR もせず secret_detected。報告に値を書かない", async () => {
    const token = fakeGithubToken();
    const s = await setup({ files: { "src/leak.js": `const token = "${token}";\n` } });
    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({ kind: "failed", failure: "secret_detected" });
    expect(await s.remoteBranch()).toBeUndefined();
    expect(s.github.count("createPullRequest")).toBe(0);
    expect(s.github.count("getCloneAccess")).toBe(0);
    expect(s.jobRow().status).toBe("failed");
    expect(s.github.comments).toHaveLength(1);
    const body = s.github.comments[0]?.body ?? "";
    expect(body).toContain("`secret_detected`");
    expect(body).toContain("`src/leak.js`:1（github-pat）");
    expect(body).not.toContain(token.slice(4));
    expect(s.notes("ship_checks")[0]).toMatchObject({ blocker: "secret_detected" });
  });

  test("gitleaks:allow を足した行は秘密情報として扱う", async () => {
    const s = await setup({ files: { "a.js": "const x = 1; // gitleaks:allow\n" } });
    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({ kind: "failed", failure: "secret_detected" });
    expect(s.github.comments[0]?.body).toContain("gitleaks-allow-comment");
  });

  test("gitleaks がなければ secret_detected（スキャンできない）", async () => {
    const s = await setup();
    const out = await shipJob({ ...s.deps, gitleaksPath: "/nonexistent/gitleaks" }, s.input());
    expect(out).toEqual({ kind: "failed", failure: "secret_detected" });
    expect(await s.remoteBranch()).toBeUndefined();
    expect(s.github.comments[0]?.body).toContain("秘密情報のスキャンを実行できませんでした");
  });

  test("CI の定義を変えたら unshippable_change で push しない", async () => {
    const s = await setup({ files: { ".github/workflows/x.yml": "on: push\n" } });
    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({ kind: "failed", failure: "unshippable_change" });
    expect(await s.remoteBranch()).toBeUndefined();
    expect(s.github.comments[0]?.body).toContain("`.github/workflows/x.yml`");
  });

  test("出荷の前の状態が judging でなければ internal_error で push しない", async () => {
    const s = await setup();
    s.db.update(jobs).set({ status: "testing" }).run();
    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({ kind: "failed", failure: "internal_error" });
    expect(await s.remoteBranch()).toBeUndefined();
    expect(s.github.count("createPullRequest")).toBe(0);
  });

  test("変更がなければ internal_error で commit・push・PR をしない", async () => {
    const s = await setup({ files: {} });
    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({ kind: "failed", failure: "internal_error" });
    expect(await s.remoteBranch()).toBeUndefined();
    expect(s.github.count("createPullRequest")).toBe(0);
  });
});

describe("shipJob: 失敗と中断", () => {
  test("push が拒否されたら ship_failed で PR を作らない", async () => {
    const s = await setup();
    // 同じ名前で別の履歴のブランチを先に置く
    const other = join(dirname(s.bare), "..", "other");
    await execa("git", ["clone", "--quiet", s.bare, other]);
    writeFileSync(join(other, "x.txt"), "x\n");
    await execa("git", ["-C", other, "add", "."]);
    await execa("git", [
      "-C",
      other,
      "-c",
      "user.name=o",
      "-c",
      "user.email=o@example.invalid",
      "commit",
      "-qm",
      "o",
    ]);
    await execa("git", [
      "-C",
      other,
      "push",
      "--quiet",
      "origin",
      "HEAD:refs/heads/agent/issue-7-job-1",
    ]);

    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({ kind: "failed", failure: "ship_failed" });
    expect(s.github.count("createPullRequest")).toBe(0);
    expect(s.github.comments[0]?.body).toContain("（push していません）");
  });

  test("PR を作れなければ ship_failed で、作業ブランチは push 済みと報告する", async () => {
    const s = await setup({ github: { fail: { createPullRequest: new Error("502") } } });
    const out = await shipJob(s.deps, s.input());
    expect(out).toEqual({ kind: "failed", failure: "ship_failed" });
    expect(await s.remoteBranch()).toBeDefined();
    expect(s.github.comments[0]?.body).toContain("（push 済み）");
  });

  test.each(["stopped", "timeout"] as const)(
    "push の前に %s なら push せず failed",
    async (kind) => {
      const s = await setup();
      const out = await shipJob(s.deps, s.input({ interruption: () => kind }));
      expect(out).toEqual({ kind: "failed", failure: kind });
      expect(await s.remoteBranch()).toBeUndefined();
      expect(s.jobRow().failure_reason).toMatch(new RegExp(`^${kind}: `));
    },
  );

  test("push を始めたあとの中断の合図は見ず、PR まで作って ci_waiting", async () => {
    const s = await setup();
    let calls = 0;
    // 1回目（push の前の確認）は undefined、それ以降は stopped を返す
    const interruption = () => (calls++ === 0 ? undefined : ("stopped" as const));
    const out = await shipJob(s.deps, s.input({ interruption }));
    expect(out).toMatchObject({ kind: "shipped" });
    expect(s.jobRow().status).toBe("ci_waiting");
  });

  test("Issue への知らせは1回で ship_report_posted を残す。失敗しても ci_waiting のまま", async () => {
    const ok = await setup();
    await shipJob(ok.deps, ok.input());
    expect(ok.github.comments).toHaveLength(1);
    expect(ok.github.comments[0]?.body).toContain("https://github.com/octo-org/demo/pull/1");
    expect(ok.notes("ship_report_posted")).toHaveLength(1);

    const ng = await setup({ github: { fail: { createIssueComment: new Error("502") } } });
    const out = await shipJob(ng.deps, ng.input());
    expect(out).toMatchObject({ kind: "shipped" });
    expect(ng.jobRow().status).toBe("ci_waiting");
    expect(ng.events().filter((e) => e.type === "error")).toHaveLength(1);
    expect(ng.notes("ship_report_failed")).toHaveLength(1);
  });

  test("LLM を呼ばず、ログにトークンが現れない", async () => {
    const s = await setup({
      github: { fail: { createPullRequest: new Error(`denied ${TOKEN}`) } },
    });
    await shipJob(s.deps, s.input());
    expect(s.db.select().from(llmCalls).all()).toEqual([]);
    expect(s.logs()).not.toContain(TOKEN);
    expect(s.github.comments[0]?.body).not.toContain(TOKEN);
  });
});

describe("shipJob: 自動マージの条件の設定（US4）", () => {
  const twentyLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

  test("max_diff_lines = 10 なら 20 行の変更は Draft", async () => {
    const s = await setup({
      configExtra: "[auto_merge]\nmax_diff_lines = 10\n",
      files: { "notes.md": `${twentyLines}\n` },
    });
    const out = await shipJob(s.deps, s.input());
    expect(out).toMatchObject({ decision: "draft" });
    expect(s.notes("shipped")[0]).toMatchObject({ unmet: ["diff_size"] });
  });

  test("allowed_work_types に feature を足せば feature でも auto-merge", async () => {
    const s = await setup({
      configExtra: '[auto_merge]\nallowed_work_types = ["docs", "feature"]\n',
    });
    const result = passed();
    if (result.plan) result.plan.work_type = "feature";
    const out = await shipJob(s.deps, s.input({ result }));
    expect(out).toMatchObject({ decision: "auto_merge" });
  });

  test("skip_label を変えれば、そのラベルで Draft になり no-auto-merge では止まらない", async () => {
    const s = await setup({
      configExtra: '[auto_merge]\nskip_label = "hold"\n',
      github: { issue: { title: "t", body: "b", labels: ["no-auto-merge"] } },
    });
    expect(await shipJob(s.deps, s.input())).toMatchObject({ decision: "auto_merge" });

    const t = await setup({
      configExtra: '[auto_merge]\nskip_label = "hold"\n',
      github: { issue: { title: "t", body: "b", labels: ["Hold"] } },
    });
    expect(await shipJob(t.deps, t.input())).toMatchObject({ decision: "draft" });
  });
});

describe("shipJob: CI 失敗後のやり直し（009 update）", () => {
  /** 最初の出荷を済ませ、やり直しの工程の終わり（judging、ci_retries = 1）にそろえる */
  async function shipped(options: SetupOptions = {}) {
    const s = await setup(options);
    const first = await shipJob(s.deps, s.input());
    expect(first.kind).toBe("shipped");
    const firstHead = await s.remoteBranch();
    s.db.update(jobs).set({ status: "judging", ci_retries: 1, ci_status: null }).run();
    const job = s.jobRow();
    const retryInput = (extra: Partial<ShipInput> = {}) =>
      s.input({
        job,
        update: { baseSha: job.base_sha as string, prNumber: 1 },
        ...extra,
      });
    return { ...s, firstHead, job, retryInput };
  }

  test("追加の commit を早送りで push し、PR は作らない。ci_waiting に戻り CI の列が新しくなる", async () => {
    const s = await shipped();
    writeFileSync(join(s.workdir, "README.md"), "# demo\n\n`pnpm run check` で検査する（直した）\n");
    const out = await shipJob(s.deps, s.retryInput());
    expect(out).toMatchObject({ kind: "shipped", prNumber: 1, decision: "auto_merge" });
    const head = await s.remoteBranch();
    expect(head).not.toBe(s.firstHead);
    const parent = await execa("git", ["-C", s.bare, "rev-parse", `${head}^`]);
    expect(parent.stdout.trim()).toBe(s.firstHead);
    expect(s.github.count("createPullRequest")).toBe(1);
    expect(s.github.comments).toHaveLength(1);
    expect(s.jobRow()).toMatchObject({
      status: "ci_waiting",
      head_sha: head,
      ci_status: "pending",
    });
    const transitions = s
      .events()
      .filter((e) => e.type === "state_changed")
      .map((e) => [e.from_status, e.to_status]);
    expect(transitions.slice(-2)).toEqual([
      ["judging", "pr_opened"],
      ["pr_opened", "ci_waiting"],
    ]);
    expect(s.notes("ci_retry_pushed")).toEqual([
      { kind: "ci_retry_pushed", head_sha: head, ci_retry: 1, decision: "auto_merge", unmet: [] },
    ]);
    const body = s.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("🔁 やり直しを push");
    expect(body).toContain("Refs #7");
  });

  test("PR の変更全体が diff の上限を超えたら、auto-merge の PR を Draft に変える", async () => {
    const s = await shipped({ configExtra: "[auto_merge]\nmax_diff_lines = 4" });
    expect(s.github.pullRequests[0]?.autoMerge).toBe(true);
    writeFileSync(join(s.workdir, "NOTES.md"), "1\n2\n3\n");
    const out = await shipJob(s.deps, s.retryInput());
    expect(out).toMatchObject({ kind: "shipped", decision: "draft" });
    expect(s.github.pullRequests[0]?.draft).toBe(true);
    expect(s.notes("ci_retry_pushed")[0]).toMatchObject({ decision: "draft", unmet: ["diff_size"] });
  });

  test("Draft の PR は条件を満たしても Draft のまま", async () => {
    const s = await shipped();
    const pr = s.github.pullRequests[0];
    if (pr) {
      pr.draft = true;
      pr.autoMerge = false;
    }
    writeFileSync(join(s.workdir, "README.md"), "# demo\n\n直した\n");
    const out = await shipJob(s.deps, s.retryInput());
    expect(out).toMatchObject({ kind: "shipped", decision: "draft" });
    expect(s.github.count("enableAutoMerge")).toBe(1);
    expect(s.github.count("convertToDraft")).toBe(0);
  });

  test("前回の push からの変更がなければ ci_unfixed で push しない", async () => {
    const s = await shipped();
    const out = await shipJob(s.deps, s.retryInput());
    expect(out).toEqual({ kind: "failed", failure: "ci_unfixed" });
    expect(await s.remoteBranch()).toBe(s.firstHead);
    expect(s.jobRow().failure_reason).toMatch(/^ci_unfixed: /);
  });

  test("PR が閉じていれば pr_closed で push しない", async () => {
    const s = await shipped();
    s.github.closePullRequest(1);
    writeFileSync(join(s.workdir, "README.md"), "# demo\n\n直した\n");
    const out = await shipJob(s.deps, s.retryInput());
    expect(out).toEqual({ kind: "failed", failure: "pr_closed" });
    expect(await s.remoteBranch()).toBe(s.firstHead);
  });
});
