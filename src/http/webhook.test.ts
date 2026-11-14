import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { FakeGitHub, type FakeGitHubOptions, signedRequest } from "../github/testing.ts";
import { createLogger } from "../log.ts";
import { budget, deployments, jobEvents, jobs, llmCalls } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { createApp } from "./app.ts";
import { createWebhookHandler } from "./webhook.ts";

const SECRET = "test-webhook-secret";
const NOW = Date.UTC(2026, 10, 12, 3);
const FIXTURES = join(import.meta.dirname, "../github/fixtures");
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

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
[github]
allowed_users = ["Octo-Requester"]
webhook_max_body_kb = 64
max_instruction_chars = 100
`,
  "/srv/factory",
);

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({ level: "info" }, stream);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, records, text: () => lines.join("\n") };
}

function setup(
  options: {
    github?: FakeGitHubOptions;
    config?: typeof CONFIG;
    permissionTimeoutMs?: number;
  } = {},
) {
  const handle = migratedMemoryDb();
  const log = capture();
  const github = new FakeGitHub({
    permissions: { "octo-requester": "write" },
    ...options.github,
  });
  let wakes = 0;
  let ciWakes = 0;
  let deployWakes = 0;
  const webhook = createWebhookHandler({
    db: handle.db,
    config: options.config ?? CONFIG,
    logger: log.logger,
    github,
    secret: SECRET,
    wake: () => {
      wakes += 1;
    },
    now: () => NOW,
    wakeCi: () => {
      ciWakes += 1;
    },
    wakeDeployer: () => {
      deployWakes += 1;
    },
    ...(options.permissionTimeoutMs === undefined
      ? {}
      : { permissionTimeoutMs: options.permissionTimeoutMs }),
  });
  const app = createApp({ sqlite: handle.sqlite, logger: log.logger, webhook: webhook.app });
  const post = async (init: RequestInit) => {
    const res = await app.request("/webhook", init);
    await webhook.idle();
    return res;
  };
  return {
    app,
    post,
    handle,
    github,
    log,
    wakes: () => wakes,
    ciWakes: () => ciWakes,
    deployWakes: () => deployWakes,
    webhook,
  };
}

const jobCount = (handle: ReturnType<typeof migratedMemoryDb>) =>
  handle.db.select().from(jobs).all().length;

describe("POST /webhook: 署名と本文（contracts/webhook.md 1〜4）", () => {
  test("上限を超える本文は 413 で、ジョブも GitHub の呼び出しもない", async () => {
    const { post, handle, github } = setup();
    const big = JSON.stringify({ padding: "x".repeat(65 * 1024) });
    const res = await post(signedRequest(SECRET, "issue_comment", big));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(jobCount(handle)).toBe(0);
    expect(github.calls).toEqual([]);
  });

  test("署名がないと 401 で、本文を解釈せず GitHub を呼ばない", async () => {
    const { post, handle, github } = setup();
    const init = signedRequest(SECRET, "issue_comment", fixture("issue_comment.created.agent"));
    const headers = { ...(init.headers as Record<string, string>) };
    delete headers["x-hub-signature-256"];
    const res = await post({ ...init, headers });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(jobCount(handle)).toBe(0);
    expect(github.calls).toEqual([]);
  });

  test("別の秘密で署名すると 401", async () => {
    const { post, github } = setup();
    const res = await post(
      signedRequest("other-secret", "issue_comment", fixture("issue_comment.created.agent")),
    );
    expect(res.status).toBe(401);
    expect(github.calls).toEqual([]);
  });

  test("署名のあとで本文を書き換えると 401", async () => {
    const { post } = setup();
    const init = signedRequest(SECRET, "issue_comment", fixture("issue_comment.created.agent"));
    const body = (init.body as string).replace("README", "READMF");
    const res = await post({ ...init, body });
    expect(res.status).toBe(401);
  });

  test("署名が正しく JSON が壊れていれば 400", async () => {
    const { post, handle } = setup();
    const res = await post(signedRequest(SECRET, "issue_comment", "{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payload" });
    expect(jobCount(handle)).toBe(0);
  });

  test("ping は 200 pong", async () => {
    const { post, github } = setup();
    const res = await post(signedRequest(SECRET, "ping", fixture("ping")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "pong" });
    expect(github.calls).toEqual([]);
  });

  test("応答の本文に内部の情報（秘密・パス・例外の文）がない", async () => {
    const { post } = setup();
    for (const init of [
      signedRequest("other-secret", "issue_comment", {}),
      signedRequest(SECRET, "issue_comment", "{not json"),
    ]) {
      const text = await (await post(init)).text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/\/srv|\/project|Error|at /);
    }
  });
});

const agent = (delivery = "d-1", mutate?: (p: Record<string, unknown>) => void) => {
  const payload = fixture("issue_comment.created.agent");
  mutate?.(payload);
  return signedRequest(SECRET, "issue_comment", payload, delivery);
};

describe("POST /webhook: 依頼の判定と受付（contracts/webhook.md 5〜10）", () => {
  test.each([
    "issue_comment.created.mention",
    "issue_comment.created.quote",
    "issue_comment.created.code",
    "issue_comment.created.bot",
    "issue_comment.created.pull_request",
    "issue_comment.created.closed",
    "issue_comment.edited.agent",
    "issue_comment.created.agentx",
  ])("%s は 202 ignored でジョブを作らず、権限も確かめない", async (name) => {
    const { post, handle, github } = setup();
    const res = await post(signedRequest(SECRET, "issue_comment", fixture(name)));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "ignored" });
    expect(jobCount(handle)).toBe(0);
    expect(github.calls).toEqual([]);
  });

  test("ほかのイベントは 202 ignored", async () => {
    const { post } = setup();
    const res = await post(signedRequest(SECRET, "issues", { action: "opened" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "ignored" });
  });

  test("必要な項目が欠けたペイロードは 400", async () => {
    const { post, handle } = setup();
    const res = await post(agent("d", (p) => delete p.repository));
    expect(res.status).toBe(400);
    expect(jobCount(handle)).toBe(0);
  });

  test.each(["write", "maintain", "admin"] as const)(
    "権限 %s の許可ユーザー（大文字と小文字を区別しない）は queued、リアクション1回、wake 1回",
    async (permission) => {
      const { post, handle, github, wakes } = setup({
        github: { permissions: { "octo-requester": permission } },
      });
      const started = performance.now();
      const res = await post(agent());
      expect(performance.now() - started).toBeLessThan(1000);
      expect(res.status).toBe(202);
      const all = handle.db.select().from(jobs).all();
      expect(all).toEqual([
        expect.objectContaining({
          repo: "octo-org/demo",
          issue_number: 7,
          trigger_comment_id: 6006,
          requested_by: "octo-requester",
          instruction: expect.stringContaining("pnpm の場合"),
          status: "queued",
        }),
      ]);
      expect(await res.json()).toEqual({ result: "queued", job: all[0]?.id });
      expect(github.calls.filter((c) => c.method === "addReaction")).toEqual([
        {
          method: "addReaction",
          args: { repo: "octo-org/demo", commentId: 6006, content: "eyes" },
        },
      ]);
      expect(github.comments).toEqual([]);
      expect(wakes()).toBe(1);
      const events = handle.db.select().from(jobEvents).all();
      expect(events).toEqual([
        expect.objectContaining({
          type: "note",
          detail: JSON.stringify({ kind: "accepted", delivery: "d-1" }),
        }),
      ]);
    },
  );

  test.each([
    ["read", { "octo-requester": "read" }],
    ["triage", { "octo-requester": "triage" }],
    ["権限なし", {}],
  ] as const)("%s の人は 202 ignored で、ジョブもコメントもない", async (_label, permissions) => {
    const { post, handle, github, log } = setup({ github: { permissions } });
    const res = await post(agent());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "ignored" });
    expect(jobCount(handle)).toBe(0);
    expect(github.comments).toEqual([]);
    expect(github.count("addReaction")).toBe(0);
    expect(log.records()).toContainEqual(
      expect.objectContaining({
        level: 30,
        delivery: "d-1",
        result: "ignored",
        reason: "permission",
      }),
    );
  });

  test("許可ユーザーでない人は書き込み権限があっても ignored で、権限の API も呼ばない", async () => {
    const { post, handle, github } = setup({
      github: { permissions: { "octo-outsider": "admin" } },
    });
    const res = await post(
      agent("d", (p) => {
        const comment = p.comment as { user: { login: string } };
        comment.user.login = "octo-outsider";
      }),
    );
    expect(await res.json()).toEqual({ result: "ignored" });
    expect(jobCount(handle)).toBe(0);
    expect(github.count("getPermission")).toBe(0);
  });

  test("権限の確認が例外なら 500 でジョブを作らず、配送の ID を error で残す", async () => {
    const { post, handle, log } = setup({
      github: { fail: { getPermission: new Error("installation not found") } },
    });
    const res = await post(agent("d-err"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(jobCount(handle)).toBe(0);
    expect(log.records()).toContainEqual(expect.objectContaining({ level: 50, delivery: "d-err" }));
  });

  test("権限の確認が時間の上限を超えたら 500", async () => {
    const { post, handle } = setup({
      github: { delayMs: { getPermission: 1000 } },
      permissionTimeoutMs: 30,
    });
    const started = performance.now();
    const res = await post(agent());
    expect(performance.now() - started).toBeLessThan(900);
    expect(res.status).toBe(500);
    expect(jobCount(handle)).toBe(0);
  });

  test("@agent だけなら 202 usage で、使い方のコメントが1回", async () => {
    const { post, handle, github, wakes } = setup();
    const res = await post(
      signedRequest(SECRET, "issue_comment", fixture("issue_comment.created.empty")),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "usage" });
    expect(jobCount(handle)).toBe(0);
    expect(github.comments).toEqual([
      expect.objectContaining({
        repo: "octo-org/demo",
        issueNumber: 7,
        body: expect.stringContaining("@agent"),
      }),
    ]);
    expect(wakes()).toBe(0);
  });

  test("予算の残りが1ジョブの上限を下回れば 202 budget_exhausted、止めた時刻を記録、コメント1回", async () => {
    const { post, handle, github } = setup();
    handle.db
      .insert(llmCalls)
      .values(
        Array.from({ length: 91 }, () => ({
          phase: "implement",
          role: "implementer" as const,
          model: "i",
          attempt: 1,
          latency_ms: 1,
          status: "ok" as const,
          created_at: NOW - 1000,
        })),
      )
      .run();
    const res = await post(agent());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "budget_exhausted" });
    expect(jobCount(handle)).toBe(0);
    expect(handle.db.select().from(budget).get()?.intake_stopped_at).toBe(NOW);
    expect(github.comments).toEqual([
      expect.objectContaining({ body: expect.stringContaining("予算") }),
    ]);
    expect(github.comments[0]?.body).toContain("（9）");

    await post(agent("d-2", (p) => ((p.comment as { id: number }).id = 6007)));
    expect(github.comments).toHaveLength(2);
    expect(handle.db.select().from(budget).get()?.intake_stopped_at).toBe(NOW);
  });

  test("同じ配送を2回送ると duplicate でジョブは1つ、リアクションと wake は1回", async () => {
    const { post, handle, github, wakes } = setup();
    const first = (await (await post(agent("d-1"))).json()) as { job: number };
    const res = await post(agent("d-1"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "duplicate", job: first.job });
    expect(jobCount(handle)).toBe(1);
    expect(github.count("addReaction")).toBe(1);
    expect(wakes()).toBe(1);
  });

  test("リアクションが失敗してもジョブは残り、job_events に reaction_failed", async () => {
    const { post, handle } = setup({
      github: { fail: { addReaction: new Error("502 Bad Gateway") } },
    });
    const res = await post(agent());
    expect(res.status).toBe(202);
    expect(jobCount(handle)).toBe(1);
    const events = handle.db.select().from(jobEvents).all();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        detail: expect.stringContaining('"kind":"reaction_failed"'),
      }),
    );
  });

  test("DB に書けなければ 500", async () => {
    const { post, handle } = setup();
    handle.sqlite.exec(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const res = await post(agent());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  test("ログに配送の ID と結果を出し、依頼の本文は出さない", async () => {
    const { post, log } = setup();
    await post(agent("d-log"));
    expect(log.records()).toContainEqual(
      expect.objectContaining({ level: 30, delivery: "d-log", result: "queued" }),
    );
    expect(log.text()).not.toContain("pnpm の場合");
  });
});

describe("POST /webhook: CI の知らせ（009 contracts/webhook.md）", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";

  function withWaitingJob(overrides: Partial<typeof jobs.$inferInsert> = {}) {
    const ctx = setup();
    const job = ctx.handle.db
      .insert(jobs)
      .values({
        repo: "octo-org/demo",
        issue_number: 7,
        trigger_comment_id: 1,
        requested_by: "octo-requester",
        instruction: "直して",
        status: "ci_waiting",
        branch: "agent/issue-7-job-1",
        pr_number: 3,
        head_sha: HEAD,
        ci_status: "pending",
        created_at: 1,
        updated_at: 1,
        ...overrides,
      })
      .returning()
      .get();
    return { ...ctx, job };
  }

  test("結び付く check_suite は 202 ci_noted、印を付けて見回りを起こし、GitHub を呼ばない", async () => {
    const { post, handle, github, ciWakes, job } = withWaitingJob();
    const res = await post(
      signedRequest(SECRET, "check_suite", fixture("check_suite.completed"), "d-ci"),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "ci_noted", job: job.id });
    expect(handle.db.select().from(jobs).get()?.ci_event_at).toBe(NOW);
    expect(ciWakes()).toBe(1);
    expect(github.calls).toEqual([]);
    const events = handle.db.select().from(jobEvents).all();
    expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({
      kind: "ci_event",
      event: "check_suite",
      delivery: "d-ci",
    });
  });

  test("head_sha が違う・ジョブがない check_suite は 202 ignored で見回りを起こさない", async () => {
    const { post, ciWakes } = withWaitingJob({ head_sha: "other" });
    const res = await post(signedRequest(SECRET, "check_suite", fixture("check_suite.completed")));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "ignored" });
    expect(ciWakes()).toBe(0);
  });

  test("requested の check_suite は ignored", async () => {
    const { post, handle } = withWaitingJob();
    const payload = fixture("check_suite.completed");
    payload.action = "requested";
    const res = await post(signedRequest(SECRET, "check_suite", payload));
    expect(await res.json()).toEqual({ result: "ignored" });
    expect(handle.db.select().from(jobs).get()?.ci_event_at).toBeNull();
  });

  test("PR の番号が一致する pull_request の closed は ci_noted", async () => {
    const { post, job } = withWaitingJob();
    const res = await post(
      signedRequest(SECRET, "pull_request", fixture("pull_request.closed.merged")),
    );
    expect(await res.json()).toEqual({ result: "ci_noted", job: job.id });
  });

  test("項目が欠けていれば 400、署名が違えば 401", async () => {
    const { post, app } = withWaitingJob();
    const payload = fixture("check_suite.completed");
    delete payload.check_suite;
    expect((await post(signedRequest(SECRET, "check_suite", payload))).status).toBe(400);
    const res = await app.request(
      "/webhook",
      signedRequest("wrong-secret", "check_suite", fixture("check_suite.completed")),
    );
    expect(res.status).toBe(401);
  });

  test("DB に書けなければ 500", async () => {
    const { post, handle } = withWaitingJob();
    handle.sqlite.exec(
      "CREATE TRIGGER fail_update BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const res = await post(signedRequest(SECRET, "check_suite", fixture("check_suite.completed")));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});

describe("POST /webhook: push（010 contracts/webhook.md）", () => {
  const STAGING = parseConfig(
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
[github]
allowed_users = ["Octo-Requester"]
[staging]
repo = "Octo-Org/Demo"
`,
    "/srv/factory",
  );
  const push = (overrides: Record<string, unknown> = {}) => ({
    ...fixture("push.main"),
    ...overrides,
  });

  test("main への push は 202 deploy_queued、queued で積んで実行器を起こし、GitHub を呼ばない", async () => {
    const { post, handle, github, deployWakes } = setup({ config: STAGING });
    const res = await post(signedRequest(SECRET, "push", push(), "d-push"));
    expect(res.status).toBe(202);
    const rows = handle.db.select().from(deployments).all();
    expect(await res.json()).toEqual({ result: "deploy_queued", deployment: rows[0]?.id });
    expect(rows).toMatchObject([
      {
        repo: "Octo-Org/Demo",
        commit_sha: "2".repeat(40),
        before_sha: "1".repeat(40),
        image_tag: `sakura-staging-app:${"2".repeat(12)}`,
        status: "queued",
        created_at: NOW,
        job_id: null,
      },
    ]);
    expect(deployWakes()).toBe(1);
    expect(github.calls).toEqual([]);
  });

  test("同じ commit の2回目は duplicate で、起こさない", async () => {
    const { post, handle, deployWakes } = setup({ config: STAGING });
    await post(signedRequest(SECRET, "push", push(), "d-1"));
    const res = await post(signedRequest(SECRET, "push", push(), "d-2"));
    expect(await res.json()).toMatchObject({ result: "duplicate" });
    expect(handle.db.select().from(deployments).all()).toHaveLength(1);
    expect(deployWakes()).toBe(1);
  });

  test("ブランチの作成（before が 0 だけ）は before_sha を NULL にする", async () => {
    const { post, handle } = setup({ config: STAGING });
    await post(signedRequest(SECRET, "push", push({ before: "0".repeat(40) })));
    expect(handle.db.select().from(deployments).get()?.before_sha).toBeNull();
  });

  test.each([
    ["staging_disabled", undefined, {}],
    ["repo", STAGING, { repository: { full_name: "octo-org/other", default_branch: "main" } }],
    ["ref（タグ）", STAGING, { ref: "refs/tags/v1" }],
    ["ref（ほかのブランチ）", STAGING, { ref: "refs/heads/feature" }],
    ["deleted", STAGING, { deleted: true, after: "0".repeat(40) }],
  ] as const)("%s は 202 ignored で積まない", async (_name, config, overrides) => {
    const { post, handle, deployWakes } = setup(config ? { config } : {});
    const res = await post(signedRequest(SECRET, "push", push(overrides)));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ result: "ignored" });
    expect(handle.db.select().from(deployments).all()).toEqual([]);
    expect(deployWakes()).toBe(0);
  });

  test("項目が欠けていれば 400、署名が違えば 401", async () => {
    const { post } = setup({ config: STAGING });
    const { after: _a, ...broken } = push();
    expect((await post(signedRequest(SECRET, "push", broken))).status).toBe(400);
    expect((await post(signedRequest("wrong-secret", "push", push()))).status).toBe(401);
  });

  test("DB に書けなければ 500", async () => {
    const { post, handle } = setup({ config: STAGING });
    handle.sqlite.exec("DROP TABLE deployments");
    const res = await post(signedRequest(SECRET, "push", push()));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});
