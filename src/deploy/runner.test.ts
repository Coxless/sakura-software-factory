import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { commitToBareRepo, createBareRepo, FakeGitHub } from "../github/testing.ts";
import { createLogger } from "../log.ts";
import {
  claimNextDeployment,
  enqueueDeployment,
  getDeployment,
  latestDeployment,
} from "../queue/deployments.ts";
import { type Deployment, deployments, type JobStatus, jobEvents, jobs } from "../queue/schema.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import type { HealthResult } from "./health.ts";
import {
  catchUpDeployments,
  createDeployer,
  type DeployerDeps,
  recoverDeployments,
  runDeployment,
} from "./runner.ts";
import { imageTagFor } from "./staging.ts";
import { FakeStaging } from "./testing.ts";

const REPO = "octo-org/demo";
const PR_BODY =
  "まとめ\n\n<!-- factory:ci -->\n#### CI\nCI の結果を待っています\n<!-- /factory:ci -->";

const configText = (workDir: string, staging = "") => `
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
allowed_users = ["octo-requester"]
[storage]
work_dir = "${workDir}"
[staging]
repo = "${REPO}"
${staging}
`;

const HEALTHY: HealthResult = { healthy: true, attempts: 3, last: "200" };
const UNHEALTHY: HealthResult = { healthy: false, attempts: 30, last: "500" };

async function setup(options: { staging?: string; health?: HealthResult[] } = {}) {
  const bare = await createBareRepo();
  const before = await commitToBareRepo(bare.root, { "app.txt": "ok\n" }, "base");
  const after = await commitToBareRepo(bare.root, { "app.txt": "new\n" }, "change (#5)");
  const workDir = mkdtempSync(join(tmpdir(), "factory-deploy-"));
  const handle = migratedMemoryDb();
  const config = parseConfig(configText(workDir, options.staging), "/srv/factory");
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
  const github = new FakeGitHub();
  const staging = new FakeStaging();
  const script = [...(options.health ?? [HEALTHY])];
  const healthCalls: { url: string; timeoutMs: number; intervalMs: number; successes: number }[] =
    [];
  const health: DeployerDeps["health"] = async (req) => {
    healthCalls.push({
      url: req.url,
      timeoutMs: req.timeoutMs,
      intervalMs: req.intervalMs,
      successes: req.successes,
    });
    return (script.length > 1 ? script.shift() : script[0]) as HealthResult;
  };
  const deps: DeployerDeps = {
    db: handle.db,
    config,
    logger,
    github,
    staging,
    health,
    cloneBaseUrl: bare.baseUrl,
    now: () => 1000,
  };
  /** after を積んで running にして返す */
  const queue = (commit = after, beforeSha: string | null = before): Deployment => {
    enqueueDeployment(
      handle.db,
      { repo: REPO, commitSha: commit, beforeSha, imageTag: imageTagFor(config.staging, commit) },
      1,
    );
    const claimed = claimNextDeployment(handle.db, 2);
    if (!claimed) throw new Error("claim failed");
    return claimed;
  };
  /** 前に成功したデプロイ（戻し先） */
  const previousSuccess = (commit = before) => {
    const image = imageTagFor(config.staging, commit);
    handle.db
      .insert(deployments)
      .values({
        repo: REPO,
        commit_sha: commit,
        image_tag: image,
        status: "succeeded",
        created_at: 0,
        finished_at: 0,
      })
      .run();
    staging.images.add(image);
    staging.running = image;
    return image;
  };
  /** PR #5 をマージ済みにしたジョブ */
  const mergedJob = (status: JobStatus = "merged") => {
    github.addPullRequest({ number: 5, repo: REPO, body: PR_BODY });
    github.mergePullRequest(5, after);
    return handle.db
      .insert(jobs)
      .values({
        repo: REPO,
        issue_number: 7,
        trigger_comment_id: 1,
        requested_by: "octo-requester",
        instruction: "直して",
        status,
        pr_number: 5,
        branch: "agent/issue-7-job-1",
        head_sha: "c".repeat(40),
        ci_status: status === "ci_waiting" ? "passed" : null,
        created_at: 1,
        updated_at: 1,
      })
      .returning()
      .get();
  };
  const job = (id: number) =>
    handle.db
      .select()
      .from(jobs)
      .all()
      .find((j) => j.id === id);
  const notes = (jobId: number) =>
    handle.db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.job_id === jobId && e.type !== "state_changed")
      .map((e) => JSON.parse(e.detail ?? "{}").kind as string);
  const states = (jobId: number) =>
    handle.db
      .select()
      .from(jobEvents)
      .all()
      .filter((e) => e.job_id === jobId && e.type === "state_changed")
      .map((e) => `${e.from_status}→${e.to_status}`);
  return {
    ...handle,
    bare,
    before,
    after,
    workDir,
    config,
    github,
    staging,
    deps,
    healthCalls,
    queue,
    previousSuccess,
    mergedJob,
    job,
    notes,
    states,
    logs: () => lines.join(""),
  };
}

const signal = () => new AbortController().signal;

describe("runDeployment: 成功（US1）", () => {
  test("merged のジョブ → deploying → deployed、記録と PR の本文", async () => {
    const ctx = await setup();
    const j = ctx.mergedJob();
    const d = ctx.queue();
    expect(await runDeployment(ctx.deps, d, signal())).toEqual({ kind: "succeeded" });

    expect(getDeployment(ctx.db, d.id)).toMatchObject({
      status: "succeeded",
      job_id: j.id,
      failed_stage: null,
      rolled_back: false,
      finished_at: 1000,
    });
    expect(ctx.job(j.id)?.status).toBe("deployed");
    expect(ctx.states(j.id)).toEqual(["merged→deploying", "deploying→deployed"]);
    expect(ctx.notes(j.id)).toEqual(["deploy_started", "deploy_result"]);
    const image = imageTagFor(ctx.config.staging, ctx.after);
    expect(ctx.staging.calls.filter((c) => c.method !== "removeImages")).toEqual([
      { method: "build", image, dir: join(ctx.workDir, `deploy-${d.id}`) },
      { method: "up", image },
    ]);
    expect(ctx.staging.running).toBe(image);
    const body = ctx.github.pullRequests[0]?.body ?? "";
    expect(body).toContain("<!-- /factory:ci -->\n\n<!-- factory:deploy -->");
    expect(body).toContain("✅ デプロイしました");
    expect(existsSync(join(ctx.workDir, `deploy-${d.id}`))).toBe(false);
    expect(ctx.github.comments).toEqual([]);
  });

  test("ビルドには commit のファイルが渡る", async () => {
    const ctx = await setup();
    const d = ctx.queue();
    let content = "";
    ctx.staging.buildHook = async () => {
      const { readFileSync } = await import("node:fs");
      content = readFileSync(join(ctx.workDir, `deploy-${d.id}`, "app.txt"), "utf8");
    };
    await runDeployment(ctx.deps, d, signal());
    expect(content).toBe("new\n");
  });

  test("ジョブが ci_waiting（PR はマージ済み）なら merged を経て deployed", async () => {
    const ctx = await setup();
    const j = ctx.mergedJob("ci_waiting");
    await runDeployment(ctx.deps, ctx.queue(), signal());
    expect(ctx.states(j.id)).toEqual([
      "ci_waiting→merged",
      "merged→deploying",
      "deploying→deployed",
    ]);
    expect(ctx.notes(j.id)).toEqual(["merged", "deploy_started", "deploy_result"]);
  });

  test("人間の push（PR なし）はジョブなしで succeeded", async () => {
    const ctx = await setup();
    const d = ctx.queue();
    expect(await runDeployment(ctx.deps, d, signal())).toEqual({ kind: "succeeded" });
    expect(getDeployment(ctx.db, d.id)).toMatchObject({ status: "succeeded", job_id: null });
  });

  test("ジョブが終わりの状態なら状態を変えず、job_id だけ入る", async () => {
    const ctx = await setup();
    const j = ctx.mergedJob("failed");
    const d = ctx.queue();
    await runDeployment(ctx.deps, d, signal());
    expect(getDeployment(ctx.db, d.id)?.job_id).toBe(j.id);
    expect(ctx.job(j.id)?.status).toBe("failed");
    expect(ctx.states(j.id)).toEqual([]);
  });

  test("PR を引けなければジョブなしで続け、error に残す", async () => {
    const ctx = await setup();
    ctx.mergedJob();
    ctx.github.options.fail = { findMergedPullRequest: new Error("GitHub is down") };
    const d = ctx.queue();
    expect(await runDeployment(ctx.deps, d, signal())).toEqual({ kind: "succeeded" });
    expect(getDeployment(ctx.db, d.id)).toMatchObject({ job_id: null });
    expect(getDeployment(ctx.db, d.id)?.error).toContain("ジョブに結び付けられませんでした");
  });

  test("成功のあと keep_images より古いイメージを消し、今のものは残す", async () => {
    const ctx = await setup({ staging: "keep_images = 2" });
    const tags: string[] = [];
    for (const c of ["1", "2", "3", "4"]) {
      const sha = c.repeat(40);
      const tag = imageTagFor(ctx.config.staging, sha);
      ctx.db
        .insert(deployments)
        .values({ repo: REPO, commit_sha: sha, image_tag: tag, status: "succeeded", created_at: 0 })
        .run();
      ctx.staging.images.add(tag);
      tags.push(tag);
    }
    await runDeployment(ctx.deps, ctx.queue(), signal());
    const now = imageTagFor(ctx.config.staging, ctx.after);
    expect([...ctx.staging.images].sort()).toEqual([now, tags[3]].sort());
  });

  test("設定のヘルスチェックの値が渡る（US4）", async () => {
    const ctx = await setup({
      staging:
        'port = 3199\nhealth_path = "/up"\nhealth_timeout_seconds = 10\nhealth_interval_seconds = 1\nhealth_successes = 2',
    });
    await runDeployment(ctx.deps, ctx.queue(), signal());
    expect(ctx.healthCalls).toEqual([
      { url: "http://127.0.0.1:3199/up", timeoutMs: 10_000, intervalMs: 1000, successes: 2 },
    ]);
  });

  test("public_url が PR の本文に出る（US4）", async () => {
    const ctx = await setup({ staging: 'public_url = "https://staging.example.jp"' });
    ctx.mergedJob();
    await runDeployment(ctx.deps, ctx.queue(), signal());
    expect(ctx.github.pullRequests[0]?.body).toContain("| https://staging.example.jp |");
  });
});

describe("runDeployment: ロールバックと revert PR（US2）", () => {
  test("ヘルスチェックの失敗 → 直前のイメージに戻し、revert PR を作り、rolled_back と報告", async () => {
    const ctx = await setup({ health: [UNHEALTHY, HEALTHY] });
    const previous = ctx.previousSuccess();
    const j = ctx.mergedJob();
    const d = ctx.queue();
    const outcome = await runDeployment(ctx.deps, d, signal());
    expect(outcome).toEqual({
      kind: "rolled_back",
      stage: "health",
      to: previous,
      healthy: true,
      revertPr: 2,
    });
    expect(getDeployment(ctx.db, d.id)).toMatchObject({
      status: "failed",
      failed_stage: "health",
      rolled_back: true,
      rolled_back_to: previous,
      rollback_healthy: true,
      revert_pr_number: 2,
    });
    expect(ctx.staging.running).toBe(previous);
    const revert = ctx.github.pullRequests[1];
    expect(revert).toMatchObject({
      number: 2,
      head: `factory/revert-${ctx.after.slice(0, 7)}`,
      base: "main",
      draft: false,
      autoMerge: false,
      title: `Revert ${ctx.after.slice(0, 7)}（ステージングのヘルスチェックの失敗）`,
    });
    expect(revert?.body).toContain("（PR #5）");
    expect(ctx.github.count("enableAutoMerge")).toBe(0);
    const reverted = await execa("git", [
      "--git-dir",
      join(ctx.bare.root, `${REPO}.git`),
      "show",
      `factory/revert-${ctx.after.slice(0, 7)}:app.txt`,
    ]);
    expect(reverted.stdout).toBe("ok");
    expect(ctx.job(j.id)?.status).toBe("rolled_back");
    expect(ctx.states(j.id)).toEqual(["merged→deploying", "deploying→rolled_back"]);
    expect(ctx.notes(j.id)).toEqual([
      "deploy_started",
      "revert_pr",
      "deploy_result",
      "report_posted",
    ]);
    expect(ctx.github.comments).toHaveLength(1);
    expect(ctx.github.comments[0]?.body).toContain("ステージングから戻しました");
    expect(ctx.github.comments[0]?.body).toContain("| revert PR | #2");
    expect(ctx.github.pullRequests[0]?.body).toContain("↩️ 戻しました");
  });

  test("入れ替えの失敗は release で同じく戻す", async () => {
    const ctx = await setup();
    const previous = ctx.previousSuccess();
    const image = imageTagFor(ctx.config.staging, ctx.after);
    ctx.staging.fail.up = { image, error: new Error("port is already allocated") };
    const outcome = await runDeployment(ctx.deps, ctx.queue(), signal());
    expect(outcome).toMatchObject({
      kind: "rolled_back",
      stage: "release",
      to: previous,
      healthy: true,
    });
  });

  test("直前の成功がなければステージングを止める（戻し先なし）", async () => {
    const ctx = await setup({ health: [UNHEALTHY] });
    const d = ctx.queue();
    const outcome = await runDeployment(ctx.deps, d, signal());
    expect(outcome).toMatchObject({ kind: "rolled_back", to: null, healthy: null });
    expect(ctx.staging.count("down")).toBe(1);
    expect(ctx.staging.running).toBeUndefined();
    expect(getDeployment(ctx.db, d.id)).toMatchObject({ rolled_back: true, rolled_back_to: null });
  });

  test("戻し先のイメージが消えていれば止める", async () => {
    const ctx = await setup({ health: [UNHEALTHY] });
    const previous = ctx.previousSuccess();
    ctx.staging.images.delete(previous);
    const d = ctx.queue();
    await runDeployment(ctx.deps, d, signal());
    expect(ctx.staging.count("down")).toBe(1);
    expect(getDeployment(ctx.db, d.id)?.rolled_back_to).toBeNull();
  });

  test("戻した版も不健康なら rollback_healthy = 0 とエラーのログ", async () => {
    const ctx = await setup({ health: [UNHEALTHY, UNHEALTHY] });
    ctx.previousSuccess();
    const d = ctx.queue();
    await runDeployment(ctx.deps, d, signal());
    expect(getDeployment(ctx.db, d.id)?.rollback_healthy).toBe(false);
    expect(ctx.logs()).toContain("戻した版のヘルスチェックも通りません");
  });

  test("範囲が分からなければ revert PR を作らず、理由を残す", async () => {
    const ctx = await setup({ health: [UNHEALTHY, HEALTHY] });
    ctx.previousSuccess();
    const j = ctx.mergedJob();
    const d = ctx.queue(ctx.after, null);
    await runDeployment(ctx.deps, d, signal());
    expect(ctx.github.pullRequests).toHaveLength(1);
    expect(getDeployment(ctx.db, d.id)?.revert_pr_number).toBeNull();
    expect(getDeployment(ctx.db, d.id)?.error).toContain("push の範囲が分かりません");
    expect(ctx.notes(j.id)).toContain("revert_skipped");
    expect(ctx.github.comments[0]?.body).toContain("作りませんでした");
  });

  test("revert PR の作成に失敗しても記録し、ロールバックはそのまま", async () => {
    const ctx = await setup({ health: [UNHEALTHY, HEALTHY] });
    const previous = ctx.previousSuccess();
    ctx.github.options.fail = { createPullRequest: new Error("422 Validation Failed") };
    const d = ctx.queue();
    const outcome = await runDeployment(ctx.deps, d, signal());
    expect(outcome).toMatchObject({ kind: "rolled_back", to: previous, revertPr: null });
    expect(getDeployment(ctx.db, d.id)?.error).toContain("422 Validation Failed");
  });

  test("同じジョブを2回処理しても報告は1回", async () => {
    const ctx = await setup({ health: [UNHEALTHY, HEALTHY, UNHEALTHY, HEALTHY] });
    ctx.previousSuccess();
    const j = ctx.mergedJob();
    await runDeployment(ctx.deps, ctx.queue(), signal());
    // 同じジョブの PR が別の commit で再びマージされたことにして、もう一度ロールバックさせる
    const again = await commitToBareRepo(ctx.bare.root, { "app.txt": "again\n" }, "again");
    const pr = ctx.github.pullRequests[0];
    if (pr) pr.mergeCommitSha = again;
    ctx.db.update(jobs).set({ status: "merged" }).run();
    await runDeployment(ctx.deps, ctx.queue(again, ctx.after), signal());
    expect(ctx.github.comments.filter((c) => c.issueNumber === 7)).toHaveLength(1);
    expect(ctx.job(j.id)?.status).toBe("rolled_back");
  });
});

describe("runDeployment: 失敗・中断（US3）", () => {
  test("ビルドの失敗 → failed(build)、up を呼ばず、ジョブは deploy_failed で Draft にしない", async () => {
    const ctx = await setup();
    ctx.previousSuccess();
    ctx.staging.fail.build = new Error("イメージのビルド（終了コード 1）: npm ERR!");
    const j = ctx.mergedJob();
    const d = ctx.queue();
    expect(await runDeployment(ctx.deps, d, signal())).toEqual({ kind: "failed", stage: "build" });
    expect(getDeployment(ctx.db, d.id)).toMatchObject({
      status: "failed",
      failed_stage: "build",
      rolled_back: false,
    });
    expect(ctx.staging.count("up")).toBe(0);
    expect(ctx.job(j.id)?.status).toBe("failed");
    expect(ctx.job(j.id)?.failure_reason).toContain("deploy_failed");
    expect(ctx.github.comments).toHaveLength(1);
    expect(ctx.github.comments[0]?.body).toContain("npm ERR!");
    expect(ctx.github.count("convertToDraft")).toBe(0);
    expect(ctx.github.pullRequests).toHaveLength(1);
    expect(ctx.github.pullRequests[0]?.body).toContain("❌ ビルドに失敗しました");
  });

  test("取得の失敗 → failed(fetch)", async () => {
    const ctx = await setup();
    const d = ctx.queue("d".repeat(40));
    expect(await runDeployment(ctx.deps, d, signal())).toEqual({ kind: "failed", stage: "fetch" });
    expect(getDeployment(ctx.db, d.id)?.failed_stage).toBe("fetch");
    expect(ctx.staging.count("build")).toBe(0);
  });

  test("ビルドの途中で止めると failed(interrupted)、ジョブは stopped", async () => {
    const ctx = await setup();
    const j = ctx.mergedJob();
    const controller = new AbortController();
    ctx.staging.buildHook = async () => {
      controller.abort();
    };
    const d = ctx.queue();
    expect(await runDeployment(ctx.deps, d, controller.signal)).toEqual({
      kind: "failed",
      stage: "interrupted",
    });
    expect(getDeployment(ctx.db, d.id)?.failed_stage).toBe("interrupted");
    expect(ctx.job(j.id)?.failure_reason).toContain("stopped");
    expect(ctx.staging.count("up")).toBe(0);
  });
});

describe("createDeployer", () => {
  test("積んだ順に1件ずつ処理し、起こされればすぐ動き、止まる", async () => {
    const ctx = await setup();
    const deployer = createDeployer({ ...ctx.deps, intervalMs: 60_000 });
    deployer.start();
    for (const commit of [ctx.before, ctx.after]) {
      enqueueDeployment(
        ctx.db,
        {
          repo: REPO,
          commitSha: commit,
          beforeSha: null,
          imageTag: imageTagFor(ctx.config.staging, commit),
        },
        1,
      );
    }
    deployer.wake();
    for (let i = 0; i < 100 && latestDeployment(ctx.db, REPO)?.status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await deployer.stop();
    const rows = ctx.db.select().from(deployments).all();
    expect(rows.map((r) => [r.commit_sha, r.status])).toEqual([
      [ctx.before, "succeeded"],
      [ctx.after, "succeeded"],
    ]);
    const builds = ctx.staging.calls.filter((c) => c.method === "build").map((c) => c.image);
    expect(builds).toEqual([
      imageTagFor(ctx.config.staging, ctx.before),
      imageTagFor(ctx.config.staging, ctx.after),
    ]);
  });

  test("stop で実行中のビルドを打ち切る", async () => {
    const ctx = await setup();
    let entered: () => void = () => {};
    const inBuild = new Promise<void>((resolve) => {
      entered = resolve;
    });
    ctx.staging.buildHook = (sig) =>
      new Promise<void>((resolve) => {
        entered();
        sig?.addEventListener("abort", () => resolve(), { once: true });
      });
    const deployer = createDeployer({ ...ctx.deps, intervalMs: 60_000 });
    deployer.start();
    enqueueDeployment(
      ctx.db,
      { repo: REPO, commitSha: ctx.after, beforeSha: null, imageTag: "x:y" },
      1,
    );
    deployer.wake();
    await inBuild;
    await deployer.stop();
    expect(latestDeployment(ctx.db, REPO)).toMatchObject({
      status: "failed",
      failed_stage: "interrupted",
    });
  });

  test("[staging].repo が空なら動かない", async () => {
    const ctx = await setup();
    const config = parseConfig(
      configText(ctx.workDir).replace(`repo = "${REPO}"`, 'repo = ""'),
      "/srv/factory",
    );
    const deployer = createDeployer({ ...ctx.deps, config });
    deployer.start();
    ctx.queue();
    await deployer.stop();
    expect(ctx.staging.calls).toEqual([]);
  });
});

describe("起動時の掃除と取り直し（US3）", () => {
  test("running → interrupted、deploying のジョブは restarted、queued は残り、作業ディレクトリが消える", async () => {
    const ctx = await setup();
    const j = ctx.mergedJob("deploying");
    const d = ctx.queue();
    ctx.db.update(deployments).set({ job_id: j.id }).run();
    enqueueDeployment(
      ctx.db,
      { repo: REPO, commitSha: "9".repeat(40), beforeSha: null, imageTag: "x:9" },
      3,
    );
    mkdirSync(join(ctx.workDir, "deploy-1"), { recursive: true });
    mkdirSync(join(ctx.workDir, "revert-1"), { recursive: true });
    mkdirSync(join(ctx.workDir, "job-1"), { recursive: true });
    expect(await recoverDeployments(ctx.deps)).toEqual({ interrupted: 1 });
    expect(getDeployment(ctx.db, d.id)).toMatchObject({
      status: "failed",
      failed_stage: "interrupted",
    });
    expect(ctx.job(j.id)?.status).toBe("failed");
    expect(ctx.job(j.id)?.failure_reason).toContain("restarted");
    expect(ctx.github.comments).toHaveLength(1);
    expect(ctx.github.count("convertToDraft")).toBe(0);
    expect(claimNextDeployment(ctx.db, 4)?.commit_sha).toBe("9".repeat(40));
    expect(existsSync(join(ctx.workDir, "deploy-1"))).toBe(false);
    expect(existsSync(join(ctx.workDir, "revert-1"))).toBe(false);
    expect(existsSync(join(ctx.workDir, "job-1"))).toBe(true);
  });

  test("先頭が記録にない commit なら積み、before は最後の記録の commit", async () => {
    const ctx = await setup();
    ctx.previousSuccess();
    ctx.github.options.defaultBranchHead = { branch: "main", sha: ctx.after };
    expect(await catchUpDeployments(ctx.deps)).toBe("queued");
    expect(latestDeployment(ctx.db, REPO)).toMatchObject({
      commit_sha: ctx.after,
      before_sha: ctx.before,
      status: "queued",
    });
    expect(await catchUpDeployments(ctx.deps)).toBe("up_to_date");
  });

  test("記録がひとつもなければ before は NULL で積む", async () => {
    const ctx = await setup();
    ctx.github.options.defaultBranchHead = { branch: "main", sha: ctx.after };
    expect(await catchUpDeployments(ctx.deps)).toBe("queued");
    expect(latestDeployment(ctx.db, REPO)?.before_sha).toBeNull();
  });

  test("repo が空なら GitHub を呼ばない。GitHub の失敗は error", async () => {
    const ctx = await setup();
    const config = parseConfig(
      configText(ctx.workDir).replace(`repo = "${REPO}"`, 'repo = ""'),
      "/srv/factory",
    );
    expect(await catchUpDeployments({ ...ctx.deps, config })).toBe("disabled");
    expect(ctx.github.count("getDefaultBranchHead")).toBe(0);
    ctx.github.options.fail = { getDefaultBranchHead: new Error("down") };
    expect(await catchUpDeployments(ctx.deps)).toBe("error");
  });
});
