import { chmodSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import {
  CloneError,
  changedFiles,
  cloneForJob,
  commitForJob,
  type GitRunner,
  pushBranch,
  ShipGitError,
} from "./git.ts";
import { createBareRepo } from "./testing.ts";

const TOKEN = "ghs_FakeInstallationToken0123456789abcd";

function recordingRunner() {
  const calls: { args: readonly string[]; env: Record<string, string | undefined> }[] = [];
  const run: GitRunner = async (args, options) => {
    calls.push({ args, env: options.env });
    return execa("git", args, {
      env: options.env,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.signal ? { cancelSignal: options.signal } : {}),
    });
  };
  return { calls, run };
}

describe("cloneForJob", () => {
  test("浅く取得して作業ブランチを作り、トークンを作業ディレクトリに残さない", async () => {
    const { baseUrl, root } = await createBareRepo();
    const dir = join(root, "work", "job-3", "repo");
    const { calls, run } = recordingRunner();
    await cloneForJob({
      repo: "octo-org/demo",
      token: TOKEN,
      defaultBranch: "main",
      dir,
      branch: "agent/issue-7-job-3",
      baseUrl,
      run,
    });

    const head = await execa("git", ["-C", dir, "branch", "--show-current"]);
    expect(head.stdout).toBe("agent/issue-7-job-3");
    const shallow = await execa("git", ["-C", dir, "rev-parse", "--is-shallow-repository"]);
    expect(shallow.stdout).toBe("true");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# demo\n");

    const config = readFileSync(join(dir, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(config.toLowerCase()).not.toContain("extraheader");
    const remote = await execa("git", ["-C", dir, "remote", "get-url", "origin"]);
    expect(remote.stdout).toBe(`${baseUrl}/octo-org/demo.git`);

    // トークンは clone の子プロセスの環境変数（GIT_CONFIG_VALUE_0）にだけ入る。引数には入らない
    for (const call of calls) expect(call.args.join(" ")).not.toContain(TOKEN);
    const clone = calls.find((call) => call.args.includes("clone"));
    expect(clone?.env).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`,
      GIT_TERMINAL_PROMPT: "0",
    });
    const others = calls.filter((call) => call !== clone);
    for (const call of others)
      expect(JSON.stringify(call.env)).not.toContain(
        Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
      );
  });

  test("本物の GitHub の URL は https://github.com/<owner>/<repo>.git（トークンなし）", async () => {
    const calls: (readonly string[])[] = [];
    await cloneForJob({
      repo: "octo-org/demo",
      token: TOKEN,
      defaultBranch: "main",
      dir: join(mkdtempSync(join(tmpdir(), "factory-git-")), "repo"),
      branch: "b",
      run: async (args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        "main",
        "https://github.com/octo-org/demo.git",
      ]),
    );
  });

  test("取得の失敗は CloneError で、エラーの文にトークンが入らない", async () => {
    const { root } = await createBareRepo();
    const dir = join(root, "work", "repo");
    const error = await cloneForJob({
      repo: "octo-org/missing",
      token: TOKEN,
      defaultBranch: "main",
      dir,
      branch: "b",
      baseUrl: `file://${root}`,
      run: async (args, options) => {
        const result = await execa("git", args, { env: options.env, reject: false });
        if (result.exitCode !== 0) {
          throw new Error(`${result.stderr} (token ${TOKEN} in ${options.env.GIT_CONFIG_VALUE_0})`);
        }
        return result;
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneError);
    const message = (error as Error).message;
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(message).toContain("[REDACTED]");
  });

  test("AbortSignal で中断できる", async () => {
    const { baseUrl, root } = await createBareRepo();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const error = await cloneForJob({
      repo: "octo-org/demo",
      token: TOKEN,
      defaultBranch: "main",
      dir: join(root, "work", "repo"),
      branch: "b",
      baseUrl,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloneError);
  });
});

const BOT = { name: "factory-app[bot]", email: "1234+factory-app[bot]@users.noreply.github.com" };

/** bare リポジトリから作業ブランチを作った作業ディレクトリ */
async function clonedWorkdir(branch = "agent/issue-7-job-3") {
  const { baseUrl, root } = await createBareRepo();
  const dir = join(root, "work", "repo");
  await cloneForJob({
    repo: "octo-org/demo",
    token: TOKEN,
    defaultBranch: "main",
    dir,
    branch,
    baseUrl,
  });
  return { baseUrl, root, dir, branch, bare: join(root, "octo-org", "demo.git") };
}

const git = async (dir: string, ...args: string[]) =>
  (await execa("git", ["-C", dir, ...args])).stdout;

describe("commitForJob", () => {
  test("追跡していないファイルを含み .gitignore に従う1つの commit を、ボットの名前で作る", async () => {
    const { dir } = await clonedWorkdir();
    const before = await git(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "README.md"), "# demo\n\nmore\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
    writeFileSync(join(dir, "ignored.log"), "noise\n");

    const result = await commitForJob({ dir, message: "README を直す\n\nRefs #7", author: BOT });
    expect(result).toEqual({ base: before, head: expect.any(String) });
    expect(result?.head).not.toBe(before);
    expect(await git(dir, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
    const files = (await git(dir, "show", "--name-only", "--format=", "HEAD")).split("\n").sort();
    expect(files).toEqual([".gitignore", "README.md", "new.txt"]);
    expect(await git(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s")).toBe(
      `${BOT.name} <${BOT.email}>|${BOT.name} <${BOT.email}>|README を直す`,
    );
  });

  test("作業ディレクトリのフックを実行しない", async () => {
    const { dir } = await clonedWorkdir();
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho hooked > hooked.txt\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(dir, "a.txt"), "a\n");
    const result = await commitForJob({ dir, message: "m", author: BOT });
    expect(result).toBeDefined();
    expect(await git(dir, "status", "--porcelain")).toBe("");
  });

  test("変更がなければ undefined を返し commit しない", async () => {
    const { dir } = await clonedWorkdir();
    const before = await git(dir, "rev-parse", "HEAD");
    expect(await commitForJob({ dir, message: "m", author: BOT })).toBeUndefined();
    expect(await git(dir, "rev-parse", "HEAD")).toBe(before);
  });

  test("ホストの git の設定を使わない（GIT_CONFIG_GLOBAL・GIT_CONFIG_NOSYSTEM・hooksPath）", async () => {
    const { dir } = await clonedWorkdir();
    writeFileSync(join(dir, "a.txt"), "a\n");
    const { calls, run } = recordingRunner();
    await commitForJob({ dir, message: "m", author: BOT, run });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      expect(call.args.join(" ")).toContain("core.hooksPath=/dev/null");
    }
  });
});

describe("changedFiles", () => {
  test("名前の変更は変更前と変更後の両方のパス。バイナリは行数に数えない", async () => {
    const { dir } = await clonedWorkdir();
    renameSync(join(dir, "README.md"), join(dir, "DOCS.md"));
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
    writeFileSync(join(dir, "b.txt"), "1\n2\n");
    const result = await commitForJob({ dir, message: "m", author: BOT });
    if (!result) throw new Error("commit がない");
    const changes = await changedFiles({ dir, ...result });
    expect(changes.paths.sort()).toEqual(["DOCS.md", "README.md", "b.txt", "bin.dat"]);
    expect(changes.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "DOCS.md", oldPath: "README.md" }),
        expect.objectContaining({ path: "bin.dat", status: "A" }),
      ]),
    );
    expect(changes.insertions).toBe(2);
    expect(changes.deletions).toBe(0);
    expect(changes.binary).toBe(1);
  });
});

describe("pushBranch", () => {
  test("作業ブランチだけを push し、トークンは環境変数だけで渡す", async () => {
    const { baseUrl, dir, branch, bare } = await clonedWorkdir();
    writeFileSync(join(dir, "a.txt"), "a\n");
    const result = await commitForJob({ dir, message: "m", author: BOT });
    const { calls, run } = recordingRunner();
    await pushBranch({ dir, repo: "octo-org/demo", token: TOKEN, branch, baseUrl, run });

    expect(await git(bare, "rev-parse", `refs/heads/${branch}`)).toBe(result?.head);
    expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(result?.base);
    const push = calls.find((call) => call.args.includes("push"));
    expect(push?.args).not.toContain("--force");
    expect(push?.args).not.toContain("-f");
    for (const call of calls) expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(push?.env).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect(push?.args.join(" ")).toContain("core.hooksPath=/dev/null");
    expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain(TOKEN);
  });

  test("リモートに別の履歴の同名ブランチがあれば上書きせず ShipGitError", async () => {
    const { baseUrl, root, dir, branch, bare } = await clonedWorkdir();
    // 同じ bare リポジトリに、同じ名前で別の履歴のブランチを先に置く
    const other = join(root, "other");
    await execa("git", ["clone", "--quiet", bare, other]);
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
      "other",
    ]);
    await execa("git", ["-C", other, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    const remoteBefore = await git(bare, "rev-parse", `refs/heads/${branch}`);

    writeFileSync(join(dir, "a.txt"), "a\n");
    await commitForJob({ dir, message: "mine", author: BOT });
    const error = await pushBranch({
      dir,
      repo: "octo-org/demo",
      token: TOKEN,
      branch,
      baseUrl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShipGitError);
    expect(await git(bare, "rev-parse", `refs/heads/${branch}`)).toBe(remoteBefore);
  });

  test("エラーの文のトークンを伏せる", async () => {
    const { dir } = await clonedWorkdir();
    const error = await pushBranch({
      dir,
      repo: "octo-org/demo",
      token: TOKEN,
      branch: "b",
      run: async (_args, options) => {
        throw new Error(`denied ${TOKEN} ${options.env.GIT_CONFIG_VALUE_0}`);
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShipGitError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toContain("[REDACTED]");
  });
});
