import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type FactoryConfig, parseConfig } from "./config.ts";
import { FakeStaging } from "./deploy/testing.ts";
import { commitToBareRepo, createBareRepo, FakeGitHub, signedRequest } from "./github/testing.ts";
import { createLogger } from "./log.ts";
import { type FactoryServices, installSignalHandlers, startFactory } from "./main.ts";
import type { PipelineResult } from "./pipeline/run.ts";
import { openDatabase } from "./queue/db.ts";
import { deployments, jobs } from "./queue/schema.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** port は設定では 1 以上なので、テストでは空いているポート（0）に差し替える */
function configWith(dir: string, host = "127.0.0.1", port = 0): FactoryConfig {
  const config = parseConfig(
    `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"
[models]
planner = "p"
implementer = "i"
verifier = "v"
fallback = "f"
[budget]
monthly_requests = 3000
per_job_requests = 100
[github]
allowed_users = ["Coxless"]
[storage]
database_path = "factory.db"
[http]
host = "${host}"
shutdown_timeout_seconds = 1
`,
    dir,
  );
  return { ...config, http: { ...config.http, port } };
}

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
  return { logger, records };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-main-"));
  dirs.push(dir);
  return dir;
}

describe("startFactory", () => {
  test("マイグレーションのあと待ち受け、/healthz が 200。stop() で DB を閉じる", async () => {
    const { logger, records } = capture();
    const factory = await startFactory(configWith(tempDir()), logger);
    const res = await fetch(`http://127.0.0.1:${factory.address.port}/healthz`);
    expect(res.status).toBe(200);
    expect(records().find((record) => record.msg === "factory started")).toMatchObject({
      http: { host: "127.0.0.1", port: factory.address.port },
    });

    await factory.stop();
    expect(factory.database.open).toBe(false);
    expect(records().some((record) => record.msg === "factory stopped")).toBe(true);
    await expect(factory.stop()).resolves.toBeUndefined();
  });

  test("ループバック以外で待ち受けると warn を出す", async () => {
    const { logger, records } = capture();
    const factory = await startFactory(configWith(tempDir(), "0.0.0.0"), logger);
    await factory.stop();
    expect(records().filter((record) => record.level === 40)).toEqual([
      expect.objectContaining({ msg: expect.stringContaining("Caddy を通さずに公開") }),
    ]);
  });

  test("待ち受けに失敗したら DB を閉じて投げる", async () => {
    const { logger } = capture();
    const first = await startFactory(configWith(tempDir()), logger);
    const port = first.address.port;
    await expect(startFactory(configWith(tempDir(), "127.0.0.1", port), logger)).rejects.toThrow(
      `127.0.0.1:${port}`,
    );
    await first.stop();
  });
});

describe("startFactory: 受付と Worker（007）", () => {
  const SECRET = "test-webhook-secret";
  const passed: PipelineResult = {
    outcome: "passed",
    planText: "",
    verdict: { verdict: "pass", reasons: "条件を満たす", criteria: [] },
    reason: "",
    rounds: [],
    retries: 0,
    requests: 0,
    diff: "",
    diffStat: { files: 1, insertions: 1, deletions: 0 },
    tracePath: "/tmp/t.jsonl",
  };

  async function services(github: FakeGitHub): Promise<FactoryServices> {
    const { baseUrl } = await createBareRepo();
    return {
      github,
      webhookSecret: SECRET,
      pipeline: async (input) => {
        // 本物の 005 と同じく工程の境目を知らせ、作業ディレクトリを変える
        for (const phase of ["implementing", "testing", "judging"] as const)
          input.onPhase?.(phase, 1);
        writeFileSync(join(input.workdir, "README.md"), "# demo\n\nupdated\n");
        return passed;
      },
      install: async () => ({ exitCode: 0, stderrTail: "" }),
      removeSandboxes: async () => {},
      cloneBaseUrl: baseUrl,
    };
  }

  const payload = {
    action: "created",
    issue: { number: 7, state: "open" },
    comment: { id: 11, body: "@agent README を直して", user: { login: "Coxless", type: "User" } },
    repository: { full_name: "octo-org/demo" },
  };

  test("/webhook で積んだジョブを Worker が出荷まで処理し、Issue に知らせてから stop() で止まる", async () => {
    const { logger } = capture();
    const dir = tempDir();
    const github = new FakeGitHub({ permissions: { coxless: "admin" } });
    const svc = await services(github);
    const factory = await startFactory(configWith(dir), logger, () => svc);
    const res = await fetch(
      `http://127.0.0.1:${factory.address.port}/webhook`,
      signedRequest(SECRET, "issue_comment", payload),
    );
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(github.comments).toHaveLength(1), { timeout: 5000 });
    expect(github.comments[0]?.body).toContain("PR にしました");
    expect(github.pullRequests).toHaveLength(1);
    await factory.stop();
    expect(factory.database.open).toBe(false);
  });

  test("CI の知らせで見回りが CI 通過を記録し、マージの知らせで merged に進む（009）", async () => {
    const { logger } = capture();
    const dir = tempDir();
    const github = new FakeGitHub({ permissions: { coxless: "admin" } });
    const svc = await services(github);
    const factory = await startFactory(configWith(dir), logger, () => svc);
    const url = `http://127.0.0.1:${factory.address.port}/webhook`;
    await fetch(url, signedRequest(SECRET, "issue_comment", payload));
    const row = () =>
      factory.database.prepare("SELECT status, ci_status, branch, head_sha FROM jobs").get() as {
        status: string;
        ci_status: string | null;
        branch: string;
        head_sha: string;
      };
    await vi.waitFor(() => expect(row().status).toBe("ci_waiting"), { timeout: 10_000 });
    const { branch, head_sha } = row();
    github.setCheckRuns(head_sha, [
      { id: 1, name: "test", status: "completed", conclusion: "success", app: "github-actions" },
    ]);
    const suite = {
      action: "completed",
      check_suite: { head_branch: branch, head_sha },
      repository: { full_name: "octo-org/demo" },
    };
    const res = await fetch(url, signedRequest(SECRET, "check_suite", suite, "d-ci"));
    expect(await res.json()).toMatchObject({ result: "ci_noted" });
    await vi.waitFor(() => expect(row().ci_status).toBe("passed"), { timeout: 5000 });

    github.mergePullRequest(1);
    const closed = {
      action: "closed",
      pull_request: { number: 1, merged: true },
      repository: { full_name: "octo-org/demo" },
    };
    await fetch(url, signedRequest(SECRET, "pull_request", closed, "d-pr"));
    await vi.waitFor(() => expect(row().status).toBe("merged"), { timeout: 5000 });
    expect(github.pullRequests[0]?.body).toContain("🎉 マージ");
    await factory.stop();
  });

  test("起動時に、処理中のまま残ったジョブを restarted で failed にしてから待ち受ける", async () => {
    const { logger } = capture();
    const dir = tempDir();
    const config = configWith(dir);
    const first = await startFactory(config, logger);
    await first.stop();
    const handle = openDatabase(config.storage.database_path);
    handle.db
      .insert(jobs)
      .values({
        repo: "octo-org/demo",
        issue_number: 7,
        trigger_comment_id: 1,
        requested_by: "Coxless",
        instruction: "x",
        status: "implementing",
        created_at: 1,
        updated_at: 1,
      })
      .run();
    handle.close();

    const github = new FakeGitHub();
    const svc = await services(github);
    const factory = await startFactory(config, logger, () => svc);
    const [job] = factory.database.prepare("SELECT status, failure_reason FROM jobs").all() as {
      status: string;
      failure_reason: string;
    }[];
    expect(job?.status).toBe("failed");
    expect(job?.failure_reason).toMatch(/^restarted: /);
    expect(github.comments).toHaveLength(1);
    await factory.stop();
  });
});

describe("installSignalHandlers", () => {
  test("1回目の合図で stop() してから 0 で終わる", async () => {
    const signals = new EventEmitter();
    const stop = vi.fn(async () => {});
    const exit = vi.fn();
    installSignalHandlers({ signals, stop, exit });
    signals.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("停止中の2回目の合図で即座に終わる（SIGINT は 130、SIGTERM は 143）", async () => {
    const signals = new EventEmitter();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    installSignalHandlers({ signals, stop, exit });
    signals.emit("SIGINT", "SIGINT");
    signals.emit("SIGINT", "SIGINT");
    expect(exit).toHaveBeenCalledWith(130);

    const signals2 = new EventEmitter();
    const exit2 = vi.fn();
    installSignalHandlers({ signals: signals2, stop, exit: exit2 });
    signals2.emit("SIGTERM", "SIGTERM");
    signals2.emit("SIGTERM", "SIGTERM");
    expect(exit2).toHaveBeenCalledWith(143);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test("stop() が失敗したら 1 で終わる", async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    installSignalHandlers({ signals, stop: async () => Promise.reject(new Error("x")), exit });
    signals.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});

describe("startFactory: ステージングデプロイ（010）", () => {
  const SECRET = "test-webhook-secret";

  /** /healthz が 200 を返すサーバー（ステージングの代わり） */
  async function healthServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
      res.statusCode = req.url === "/healthz" ? 200 : 404;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  function stagingConfig(dir: string, port: number): FactoryConfig {
    const base = configWith(dir);
    return {
      ...base,
      staging: {
        ...base.staging,
        repo: "octo-org/demo",
        port,
        health_successes: 1,
        health_interval_seconds: 1,
        health_timeout_seconds: 5,
      },
    };
  }

  test("main への push を受けてビルド・入れ替え・ヘルスチェックをして succeeded にする", async () => {
    const { logger } = capture();
    const dir = tempDir();
    const health = await healthServer();
    const { baseUrl, root } = await createBareRepo();
    const sha = await commitToBareRepo(root, { "app.txt": "v1\n" }, "v1");
    const github = new FakeGitHub({ defaultBranchHead: { branch: "main", sha } });
    const staging = new FakeStaging();
    const factory = await startFactory(stagingConfig(dir, health.port), logger, () => ({
      github,
      webhookSecret: SECRET,
      pipeline: async () => {
        throw new Error("呼ばれない");
      },
      install: async () => ({ exitCode: 0, stderrTail: "" }),
      removeSandboxes: async () => {},
      cloneBaseUrl: baseUrl,
      staging,
    }));
    const row = () =>
      factory.database.prepare("SELECT commit_sha, status FROM deployments").all() as {
        commit_sha: string;
        status: string;
      }[];
    // 起動時の取り直しで main の先頭が積まれ、デプロイされる
    await vi.waitFor(() => expect(row()).toEqual([{ commit_sha: sha, status: "succeeded" }]), {
      timeout: 10_000,
    });
    const next = await commitToBareRepo(root, { "app.txt": "v2\n" }, "v2");
    const res = await fetch(
      `http://127.0.0.1:${factory.address.port}/webhook`,
      signedRequest(SECRET, "push", {
        ref: "refs/heads/main",
        before: sha,
        after: next,
        repository: { full_name: "octo-org/demo", default_branch: "main" },
      }),
    );
    expect(await res.json()).toMatchObject({ result: "deploy_queued" });
    await vi.waitFor(() => expect(row()[1]).toEqual({ commit_sha: next, status: "succeeded" }), {
      timeout: 10_000,
    });
    expect(staging.running).toBe(`sakura-staging-app:${next.slice(0, 12)}`);
    await factory.stop();
    await health.close();
  });

  test("起動時に、途中のデプロイを interrupted にし、deploying のジョブを restarted で failed にする", async () => {
    const { logger } = capture();
    const dir = tempDir();
    const config = stagingConfig(dir, 1024);
    const first = await startFactory(config, logger);
    await first.stop();
    const handle = openDatabase(config.storage.database_path);
    const job = handle.db
      .insert(jobs)
      .values({
        repo: "octo-org/demo",
        issue_number: 7,
        trigger_comment_id: 1,
        requested_by: "Coxless",
        instruction: "x",
        status: "deploying",
        pr_number: 3,
        created_at: 1,
        updated_at: 1,
      })
      .returning()
      .get();
    handle.db
      .insert(deployments)
      .values({
        repo: "octo-org/demo",
        job_id: job.id,
        commit_sha: "a".repeat(40),
        image_tag: "x:a",
        status: "running",
        created_at: 1,
      })
      .run();
    handle.close();

    const github = new FakeGitHub({
      defaultBranchHead: { branch: "main", sha: "a".repeat(40) },
    });
    github.addPullRequest({ number: 3, state: "closed", merged: true });
    const factory = await startFactory(config, logger, () => ({
      github,
      webhookSecret: SECRET,
      pipeline: async () => {
        throw new Error("呼ばれない");
      },
      install: async () => ({ exitCode: 0, stderrTail: "" }),
      removeSandboxes: async () => {},
      staging: new FakeStaging(),
    }));
    const [j] = factory.database.prepare("SELECT status, failure_reason FROM jobs").all() as {
      status: string;
      failure_reason: string;
    }[];
    expect(j?.status).toBe("failed");
    expect(j?.failure_reason).toMatch(/^restarted: /);
    const [d] = factory.database.prepare("SELECT status, failed_stage FROM deployments").all();
    expect(d).toEqual({ status: "failed", failed_stage: "interrupted" });
    expect(github.comments).toHaveLength(1);
    expect(github.count("convertToDraft")).toBe(0);
    await factory.stop();
  });
});
