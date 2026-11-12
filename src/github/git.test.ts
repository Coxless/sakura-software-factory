import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { CloneError, cloneForJob, type GitRunner } from "./git.ts";
import { createBareRepo } from "./testing.ts";

const TOKEN = "ghs_FakeInstallationToken0123456789abcd";

function recordingRunner() {
  const calls: { args: readonly string[]; env: Record<string, string | undefined> }[] = [];
  const run: GitRunner = async (args, options) => {
    calls.push({ args, env: options.env });
    return execa("git", args, {
      env: options.env,
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
