import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createSandbox,
  decode,
  installDependencies,
  removeStaleSandboxes,
  type Sandbox,
  SandboxError,
  withSandbox,
} from "./docker.ts";
import { dockerSkipReason, makeWorkspace, reportSkip, testSandboxConfig } from "./testing.ts";

const skip = await dockerSkipReason();
reportSkip(skip);

/** テストごとに重ならないジョブ ID（同時に走る別ファイルのテストとも重ならない範囲） */
let nextJobId = 900_000 + (process.pid % 1000) * 100;
const jobId = () => nextJobId++;

async function containerExists(name: string): Promise<boolean> {
  const result = await execa("docker", ["ps", "--all", "--quiet", "--filter", `name=^${name}$`]);
  return result.stdout.trim().length > 0;
}

async function sh(sandbox: Sandbox, command: string) {
  const result = await sandbox.exec(["sh", "-c", command]);
  return { code: result.exitCode, out: decode(result.stdout), err: decode(result.stderr) };
}

describe.skipIf(skip)("作業場（層5）", () => {
  let ws: Awaited<ReturnType<typeof makeWorkspace>>;
  let sandbox: Sandbox;
  let startMs: number;

  beforeAll(async () => {
    ws = await makeWorkspace();
    process.env.SAKURA_AI_API_KEY = "sk-test-should-not-leak";
    const started = performance.now();
    sandbox = await createSandbox({
      jobId: jobId(),
      workspace: ws.path,
      sandbox: testSandboxConfig(),
    });
    startMs = performance.now() - started;
  });

  afterAll(async () => {
    await sandbox?.destroy();
    ws?.cleanup();
    delete process.env.SAKURA_AI_API_KEY;
  });

  test("用意が10秒以内（SC-005）", () => {
    expect(startMs).toBeLessThan(10_000);
  });

  test("作業ディレクトリを読み書きでき、ホストに反映される", async () => {
    expect((await sh(sandbox, "cat README.md")).out).toBe("# test\n");
    expect((await sh(sandbox, "echo from-sandbox > note.txt")).code).toBe(0);
    expect(readFileSync(join(ws.path, "note.txt"), "utf8")).toBe("from-sandbox\n");
  });

  test("外部に接続できない", async () => {
    const result = await sh(
      sandbox,
      "getent hosts example.com || node -e \"fetch('http://1.1.1.1').then(()=>process.exit(0),()=>process.exit(7))\"",
    );
    expect(result.code).not.toBe(0);
    const ifaces = await sh(sandbox, "ls /sys/class/net");
    expect(ifaces.out.trim()).toBe("lo");
  });

  test("作業ディレクトリと /tmp 以外に書けない", async () => {
    const root = await sh(sandbox, "touch /x");
    expect(root.code).not.toBe(0);
    expect(root.err).toMatch(/Read-only file system|Permission denied/);
    expect((await sh(sandbox, "touch /tmp/ok")).code).toBe(0);
  });

  test(".git に書けない", async () => {
    const result = await sh(sandbox, "echo x > .git/hooks/pre-commit");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("Read-only file system");
    // 読み取りはできる（git のないイメージでテストしているときは飛ばす。journal 参照）
    if ((await sh(sandbox, "command -v git")).code === 0) {
      expect((await sh(sandbox, "git status --short")).code).toBe(0);
    }
  });

  test("root ではなく、特権を持たない", async () => {
    const id = await sh(sandbox, "id -u");
    expect(id.out.trim()).not.toBe("0");
    const caps = await sh(sandbox, "grep -E '^Cap(Eff|Prm|Bnd)' /proc/self/status");
    for (const line of caps.out.trim().split("\n")) expect(line).toMatch(/0000000000000000$/);
    expect((await sh(sandbox, "grep NoNewPrivs /proc/self/status")).out).toMatch(/NoNewPrivs:\s+1/);
  });

  test("プロセス数の上限を超えるとフォークに失敗する", async () => {
    // 残った sleep でほかのテストがフォークできなくならないよう、専用の作業場で確かめる
    const own = await makeWorkspace();
    await withSandbox(
      { jobId: jobId(), workspace: own.path, sandbox: testSandboxConfig({ pids_limit: 32 }) },
      async (s) => {
        const result = await sh(s, "for i in $(seq 100); do sleep 3 & done 2>&1; wait; echo done");
        expect(`${result.out}${result.err}`).toMatch(
          /fork|Resource temporarily unavailable|Interrupted system call/,
        );
      },
    );
    own.cleanup();
  });

  test("ホストの環境変数（秘密情報）を引き継がない（SC-007）", async () => {
    const env = (await sh(sandbox, "env")).out;
    expect(env).not.toContain("sk-test-should-not-leak");
    expect(env).not.toContain("SAKURA_AI_API_KEY");
    expect(env).toContain("HOME=/tmp");
  });

  test("realpath がシンボリックリンクを解決する", async () => {
    await sh(
      sandbox,
      "mkdir -p .github/workflows && ln -sf .github/workflows/ci.yml ci.yml && ln -sf /etc/passwd passwd",
    );
    expect(await sandbox.realpath("/workspace/ci.yml")).toBe("/workspace/.github/workflows/ci.yml");
    expect(await sandbox.realpath("passwd")).toBe("/etc/passwd");
    expect(await sandbox.realpath("not/yet/there.ts")).toBe("/workspace/not/yet/there.ts");
  });
});

describe.skipIf(skip)("作業場の片付け（SC-002）", () => {
  test("withSandbox は例外でも片付ける", async () => {
    const ws = await makeWorkspace();
    let name = "";
    await expect(
      withSandbox(
        { jobId: jobId(), workspace: ws.path, sandbox: testSandboxConfig() },
        async (s) => {
          name = s.name;
          expect(await containerExists(name)).toBe(true);
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(await containerExists(name)).toBe(false);
    ws.cleanup();
  });

  test("destroy は2回呼べ、片付け後の exec は SandboxError(unavailable)", async () => {
    const ws = await makeWorkspace();
    const sandbox = await createSandbox({
      jobId: jobId(),
      workspace: ws.path,
      sandbox: testSandboxConfig(),
    });
    await sandbox.destroy();
    await sandbox.destroy();
    await expect(sandbox.exec(["true"])).rejects.toMatchObject({
      name: "SandboxError",
      kind: "unavailable",
    });
    ws.cleanup();
  });

  test("外から止められた作業場への exec は SandboxError(unavailable)", async () => {
    const ws = await makeWorkspace();
    const sandbox = await createSandbox({
      jobId: jobId(),
      workspace: ws.path,
      sandbox: testSandboxConfig(),
    });
    await execa("docker", ["rm", "--force", sandbox.name]);
    await expect(sandbox.exec(["true"])).rejects.toMatchObject({ kind: "unavailable" });
    ws.cleanup();
  });

  test("同じジョブ ID の残骸があっても作り直せ、removeStaleSandboxes が残骸を消す", async () => {
    const ws = await makeWorkspace();
    const id = jobId();
    const first = await createSandbox({
      jobId: id,
      workspace: ws.path,
      sandbox: testSandboxConfig(),
    });
    const second = await createSandbox({
      jobId: id,
      workspace: ws.path,
      sandbox: testSandboxConfig(),
    });
    expect(second.name).toBe(first.name);
    expect(await removeStaleSandboxes({ jobId: id })).toBe(1);
    expect(await containerExists(second.name)).toBe(false);
    ws.cleanup();
  });

  test("イメージがなければ SandboxError(image_missing) で、何も残さない", async () => {
    const ws = await makeWorkspace();
    const id = jobId();
    await expect(
      createSandbox({
        jobId: id,
        workspace: ws.path,
        sandbox: testSandboxConfig({ image: "factory-sandbox:no-such-tag" }),
      }),
    ).rejects.toMatchObject({ kind: "image_missing" });
    expect(await containerExists(`factory-job-${id}`)).toBe(false);
    ws.cleanup();
  });

  test("作業ディレクトリがなければ SandboxError(invalid_workspace)", async () => {
    await expect(
      createSandbox({ jobId: jobId(), workspace: "/nonexistent/ws", sandbox: testSandboxConfig() }),
    ).rejects.toBeInstanceOf(SandboxError);
  });
});

describe.skipIf(skip)("依存のインストール（US5）", () => {
  test("ネットワークありで入れた依存を、ネットワークなしの作業場で使える", async () => {
    const ws = await makeWorkspace({
      "package.json": JSON.stringify({
        name: "t",
        private: true,
        dependencies: { lib: "file:./lib" },
        scripts: { test: "node -e \"console.log(require('lib'))\"" },
      }),
      "lib/package.json": JSON.stringify({ name: "lib", version: "1.0.0", main: "i.js" }),
      "lib/i.js": 'module.exports = "lib-ok";\n',
    });
    // ロックファイルは作業場で作る（ホストに pnpm がなくてもよいように）
    const id = jobId();
    const lock = await installDependencies({
      jobId: id,
      workspace: ws.path,
      sandbox: testSandboxConfig(),
      command: ["pnpm", "install", "--lockfile-only"],
    });
    expect(lock.exitCode, decode(lock.stderr)).toBe(0);

    const result = await installDependencies({
      jobId: id,
      workspace: ws.path,
      sandbox: testSandboxConfig(),
      command: ["pnpm", "install", "--frozen-lockfile"],
    });
    expect(result.exitCode, decode(result.stdout) + decode(result.stderr)).toBe(0);
    expect(await containerExists(`factory-install-${id}`)).toBe(false);

    await withSandbox(
      { jobId: id, workspace: ws.path, sandbox: testSandboxConfig() },
      async (s) => {
        const run = await s.exec(["pnpm", "test"]);
        expect(decode(run.stdout)).toContain("lib-ok");
        expect(run.exitCode).toBe(0);
      },
    );
    ws.cleanup();
  });

  test("時間の上限で打ち切られ、作業場が残らない", async () => {
    const ws = await makeWorkspace();
    const id = jobId();
    const started = performance.now();
    const result = await installDependencies({
      jobId: id,
      workspace: ws.path,
      sandbox: testSandboxConfig({ install_timeout_seconds: 2 }),
      command: ["sleep", "30"],
    });
    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(await containerExists(`factory-install-${id}`)).toBe(false);
    ws.cleanup();
  });

  test("秘密情報を引き継がない", async () => {
    const ws = await makeWorkspace();
    process.env.GITHUB_APP_PRIVATE_KEY = "should-not-leak";
    const result = await installDependencies({
      jobId: jobId(),
      workspace: ws.path,
      sandbox: testSandboxConfig(),
      command: ["env"],
    });
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(decode(result.stdout)).not.toContain("should-not-leak");
    expect(decode(result.stdout)).toContain("HOME=/tmp");
    ws.cleanup();
  });

  test("作業場で書いたファイルの所有者は実行ユーザー", async () => {
    const ws = await makeWorkspace();
    writeFileSync(join(ws.path, "x.txt"), "x");
    await withSandbox(
      { jobId: jobId(), workspace: ws.path, sandbox: testSandboxConfig() },
      async (s) => {
        const result = await s.exec(["sh", "-c", "touch made.txt && stat -c %u:%g made.txt"]);
        expect(decode(result.stdout).trim()).toBe(testSandboxConfig().user);
      },
    );
    ws.cleanup();
  });
});
