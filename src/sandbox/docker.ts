import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execa } from "execa";
import {
  buildRunArgs,
  containerName,
  LABEL,
  resolveUser,
  type SandboxConfig,
  SandboxError,
} from "./options.ts";
import { WORKSPACE } from "./paths.ts";

export { SandboxError } from "./options.ts";

/** 出力の取り込みの上限。超えたら打ち切って truncated にする */
const MAX_BUFFER = 5 * 1024 * 1024;
/** docker CLI 自体の操作（run -d・rm など）の時間の上限 */
const DOCKER_TIMEOUT_MS = 60_000;

export type ExecResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
};

export type ExecOptions = {
  input?: string | Uint8Array;
  /** ホスト側での打ち切り（作業場の中の timeout が効かなかったときの保険） */
  timeoutSeconds?: number;
  signal?: AbortSignal;
};

export type SandboxOptions = {
  jobId: number;
  /** ホストの作業ディレクトリ（絶対パス） */
  workspace: string;
  sandbox: SandboxConfig;
};

export interface Sandbox {
  readonly jobId: number;
  readonly name: string;
  readonly workspace: string;
  /** 作業場の中でコマンドを実行する（作業ディレクトリ・作業場の実行ユーザーで） */
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** 作業場の中で realpath -m（相対パスは /workspace 基準） */
  realpath(path: string): Promise<string>;
  /** 片付ける。何度呼んでもよい */
  destroy(): Promise<void>;
}

const decoder = new TextDecoder();
export const decode = (bytes: Uint8Array): string => decoder.decode(bytes);

type RawResult = ExecResult & { notFound: boolean };

async function runDocker(args: readonly string[], options: ExecOptions = {}): Promise<RawResult> {
  const started = performance.now();
  const result = await execa("docker", args, {
    reject: false,
    encoding: "buffer",
    stripFinalNewline: false,
    maxBuffer: MAX_BUFFER,
    timeout: (options.timeoutSeconds ?? DOCKER_TIMEOUT_MS / 1000) * 1000,
    forceKillAfterDelay: 2000,
    ...(options.input !== undefined ? { input: options.input } : { stdin: "ignore" }),
    ...(options.signal ? { cancelSignal: options.signal } : {}),
  });
  const notFound = (result as { code?: string }).code === "ENOENT";
  return {
    exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
    stdout: toBytes(result.stdout),
    stderr: toBytes(result.stderr),
    timedOut: result.timedOut,
    truncated: result.isMaxBuffer,
    durationMs: Math.round(performance.now() - started),
    notFound,
  };
}

function toBytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array();
}

/** docker CLI のエラーを種類に分ける */
function classify(
  result: RawResult,
  fallback: SandboxError["kind"],
  context: string,
): SandboxError {
  const stderr = decode(result.stderr).trim();
  if (result.notFound) {
    return new SandboxError("docker_unavailable", `${context}: docker コマンドが見つかりません`);
  }
  if (
    /Cannot connect to the Docker daemon|failed to connect to the docker API|docker daemon is not running/i.test(
      stderr,
    )
  ) {
    return new SandboxError(
      "docker_unavailable",
      `${context}: Docker デーモンに接続できません: ${stderr}`,
    );
  }
  if (/No such image|Unable to find image|pull access denied/i.test(stderr)) {
    return new SandboxError(
      "image_missing",
      `${context}: 作業場のイメージがありません（pnpm run sandbox:build で作ってください）: ${stderr}`,
    );
  }
  return new SandboxError(fallback, `${context}: ${stderr || `終了コード ${result.exitCode}`}`);
}

const CONTAINER_GONE =
  /^Error response from daemon: (?:No such container|container \S+ is not running|Container \S+ is not running)/m;

async function removeContainer(name: string): Promise<void> {
  await runDocker(["rm", "--force", name]);
}

function checkWorkspace(workspace: string): void {
  if (!isAbsolute(workspace) || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new SandboxError(
      "invalid_workspace",
      `作業ディレクトリが絶対パスの既存のディレクトリではありません: ${workspace}`,
    );
  }
}

function hasGitDir(workspace: string): boolean {
  const git = join(workspace, ".git");
  return existsSync(git) && statSync(git).isDirectory();
}

/**
 * ジョブ専用の作業場（ネットワークなし）を起動する。
 * 同じ名前の残骸があれば先に片付ける。失敗したら途中のものを残さない。
 */
export async function createSandbox(options: SandboxOptions): Promise<Sandbox> {
  const { jobId, workspace, sandbox } = options;
  checkWorkspace(workspace);
  const user = resolveUser(sandbox.user);
  const name = containerName("job", jobId);
  await removeContainer(name);
  const args = buildRunArgs({
    kind: "job",
    jobId,
    workspace,
    hasGitDir: hasGitDir(workspace),
    user,
    sandbox,
    command: ["sleep", "infinity"],
  });
  const started = await runDocker(["run", ...args]);
  if (started.exitCode !== 0) {
    await removeContainer(name);
    throw classify(started, "start_failed", `作業場 ${name} を起動できません`);
  }

  let destroyed = false;
  const exec = async (
    argv: readonly string[],
    execOptions: ExecOptions = {},
  ): Promise<ExecResult> => {
    if (destroyed) throw new SandboxError("unavailable", `作業場 ${name} は片付け済みです`);
    const flags = execOptions.input !== undefined ? ["--interactive"] : [];
    const result = await runDocker(
      ["exec", ...flags, "--workdir", WORKSPACE, name, ...argv],
      execOptions,
    );
    if (result.notFound) throw classify(result, "unavailable", "コマンドを実行できません");
    if (result.exitCode !== 0 && CONTAINER_GONE.test(decode(result.stderr))) {
      throw new SandboxError(
        "unavailable",
        `作業場 ${name} が使えません（コンテナが停止しています）: ${decode(result.stderr).trim()}`,
      );
    }
    const { notFound: _, ...rest } = result;
    return rest;
  };

  return {
    jobId,
    name,
    workspace,
    exec,
    async realpath(path) {
      const result = await exec(["realpath", "-m", "--", path]);
      if (result.exitCode !== 0) {
        throw new SandboxError(
          "unavailable",
          `realpath に失敗しました: ${decode(result.stderr).trim()}`,
        );
      }
      return decode(result.stdout).replace(/\n$/, "");
    },
    async destroy() {
      destroyed = true;
      await removeContainer(name);
    },
  };
}

/** 作業場を用意して fn を実行し、成功・失敗・例外のどれでも片付ける */
export async function withSandbox<T>(
  options: SandboxOptions,
  fn: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.destroy();
  }
}

/**
 * ファクトリーが作った作業場の残骸（異常終了で残ったもの）を片付け、数を返す。
 * jobId を渡すとそのジョブの分だけ（テスト用）。
 */
export async function removeStaleSandboxes(options: { jobId?: number } = {}): Promise<number> {
  const filters = ["--filter", `label=${LABEL}=1`];
  if (options.jobId !== undefined)
    filters.push("--filter", `label=sakura-factory.job-id=${options.jobId}`);
  const listed = await runDocker(["ps", "--all", "--quiet", ...filters]);
  if (listed.exitCode !== 0) throw classify(listed, "unavailable", "作業場の一覧を取得できません");
  const ids = decode(listed.stdout).split("\n").filter(Boolean);
  if (ids.length > 0) {
    const removed = await runDocker(["rm", "--force", ...ids]);
    if (removed.exitCode !== 0)
      throw classify(removed, "unavailable", "作業場の残骸を片付けられません");
  }
  return ids.length;
}

/**
 * 依存のインストールだけを、ネットワークありの一時的な作業場で1回実行する（research R10）。
 * ネットワーク以外の隔離は実装工程と同じ。時間の上限を超えたら止め、どの場合も作業場を残さない。
 * コマンドの失敗は例外にせず、終了コードで返す（docker 自体の失敗は SandboxError）。
 */
export async function installDependencies(
  options: SandboxOptions & { command: readonly string[] },
): Promise<ExecResult> {
  const { jobId, workspace, sandbox, command } = options;
  checkWorkspace(workspace);
  const user = resolveUser(sandbox.user);
  const name = containerName("install", jobId);
  await removeContainer(name);
  const args = buildRunArgs({
    kind: "install",
    jobId,
    workspace,
    hasGitDir: hasGitDir(workspace),
    user,
    sandbox,
    command,
  });
  try {
    const result = await runDocker(["run", ...args], {
      timeoutSeconds: sandbox.install_timeout_seconds,
    });
    if (result.exitCode === 125 && !result.timedOut) {
      throw classify(result, "start_failed", `依存のインストールの作業場 ${name} を起動できません`);
    }
    if (result.notFound)
      throw classify(result, "docker_unavailable", "依存をインストールできません");
    const { notFound: _, ...rest } = result;
    return rest;
  } finally {
    await removeContainer(name);
  }
}
