import { describe, expect, test } from "vitest";
import { buildRunArgs, containerName, resolveUser, SandboxError } from "./options.ts";

const sandbox = {
  image: "factory-sandbox:latest",
  cpus: 2,
  memory_mb: 2048,
  pids_limit: 512,
  tmp_size_mb: 512,
  install_timeout_seconds: 600,
};

function build(kind: "job" | "install", hasGitDir = true) {
  return buildRunArgs({
    kind,
    jobId: 42,
    workspace: "/srv/ws/42",
    hasGitDir,
    user: "1001:1001",
    sandbox,
    command: ["sleep", "infinity"],
  });
}

/** 引数の並びから `--flag value` の組を探す */
function pairs(args: string[]): string[] {
  return args.slice(0, -1).map((arg, i) => `${arg} ${args[i + 1]}`);
}

describe("buildRunArgs", () => {
  test("実装工程の作業場に隔離のフラグがすべて入る", () => {
    const args = build("job");
    const p = pairs(args);
    for (const expected of [
      "--name factory-job-42",
      "--label sakura-factory.sandbox=1",
      "--label sakura-factory.job-id=42",
      "--label sakura-factory.kind=job",
      "--pull never",
      "--network none",
      "--tmpfs /tmp:rw,nosuid,size=512m",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--pids-limit 512",
      "--memory 2048m",
      "--memory-swap 2048m",
      "--cpus 2",
      "--user 1001:1001",
      "--volume /srv/ws/42:/workspace",
      "--volume /srv/ws/42/.git:/workspace/.git:ro",
      "--workdir /workspace",
    ]) {
      expect(p).toContain(expected);
    }
    expect(args).toContain("--read-only");
    expect(args).toContain("--init");
    expect(args).toContain("--detach");
    expect(args.slice(-3)).toEqual(["factory-sandbox:latest", "sleep", "infinity"]);
  });

  test("渡す環境変数は HOME=/tmp だけ", () => {
    const args = build("job");
    const envs = args.flatMap((arg, i) => (arg === "--env" || arg === "-e" ? [args[i + 1]] : []));
    expect(envs).toEqual(["HOME=/tmp"]);
    expect(args).not.toContain("--env-file");
  });

  test(".git がなければ読み取り専用のマウントを足さない", () => {
    expect(build("job", false).join(" ")).not.toContain(".git");
  });

  test("依存のインストールはブリッジで、--rm で1回だけ動かす。ほかの隔離は同じ", () => {
    const args = build("install");
    const p = pairs(args);
    expect(p).toContain("--network bridge");
    expect(p).not.toContain("--network none");
    expect(p).toContain("--name factory-install-42");
    expect(p).toContain("--cap-drop ALL");
    expect(p).toContain("--volume /srv/ws/42/.git:/workspace/.git:ro");
    expect(args).toContain("--rm");
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--detach");
  });
});

describe("containerName", () => {
  test("種類とジョブ ID から名前を作る", () => {
    expect(containerName("job", 7)).toBe("factory-job-7");
    expect(containerName("install", 7)).toBe("factory-install-7");
  });
});

describe("resolveUser", () => {
  test("設定があればそれを使う", () => {
    expect(resolveUser("1001:1002", 0, 0)).toBe("1001:1002");
  });

  test("設定がなければプロセスの uid:gid", () => {
    expect(resolveUser(undefined, 1001, 1002)).toBe("1001:1002");
  });

  test("root になる場合はエラー", () => {
    expect(() => resolveUser(undefined, 0, 0)).toThrow(SandboxError);
    expect(() => resolveUser("0:0", 1000, 1000)).toThrow(/sandbox.user/);
    try {
      resolveUser(undefined, 0, 0);
    } catch (error) {
      expect((error as SandboxError).kind).toBe("invalid_user");
      expect((error as SandboxError).message).toContain("[sandbox] user");
    }
  });
});
