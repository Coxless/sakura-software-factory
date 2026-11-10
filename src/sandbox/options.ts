import type { FactoryConfig } from "../config.ts";
import { WORKSPACE } from "./paths.ts";

export type SandboxConfig = FactoryConfig["sandbox"];

/** job: 実装工程の作業場（ネットワークなし、常駐）。install: 依存のインストール（ネットワークあり、1回だけ） */
export type SandboxKind = "job" | "install";

export type SandboxErrorKind =
  | "docker_unavailable"
  | "image_missing"
  | "start_failed"
  | "unavailable"
  | "invalid_user"
  | "invalid_workspace";

export class SandboxError extends Error {
  readonly kind: SandboxErrorKind;

  constructor(kind: SandboxErrorKind, message: string) {
    super(message);
    this.name = "SandboxError";
    this.kind = kind;
  }
}

/** ファクトリーが作ったコンテナに付ける印。残骸の片付けで使う */
export const LABEL = "sakura-factory.sandbox";

export function containerName(kind: SandboxKind, jobId: number): string {
  return `factory-${kind}-${jobId}`;
}

/**
 * 作業場の実行ユーザー（uid:gid）を決める（research R4）。
 * 設定があればそれ、なければファクトリーのプロセスと同じ。root にはしない。
 */
export function resolveUser(
  configured: string | undefined,
  uid: number | undefined = process.getuid?.(),
  gid: number | undefined = process.getgid?.(),
): string {
  if (configured !== undefined) {
    if (!/^[0-9]+:[0-9]+$/.test(configured) || /^0+:/.test(configured)) {
      throw new SandboxError("invalid_user", `sandbox.user が正しくありません: ${configured}`);
    }
    return configured;
  }
  if (uid === undefined || gid === undefined) {
    throw new SandboxError("invalid_user", "uid を取得できません。sandbox.user を設定してください");
  }
  if (uid === 0) {
    throw new SandboxError(
      "invalid_user",
      "ファクトリーが root で動いているため、作業場の実行ユーザーを決められません。factory.toml の [sandbox] user に root 以外の <uid>:<gid> を設定してください",
    );
  }
  return `${uid}:${gid}`;
}

/** `docker run` の引数（`run` の後ろからイメージとコマンドまで）を組み立てる（research R2・R3・R10） */
export function buildRunArgs(options: {
  kind: SandboxKind;
  jobId: number;
  workspace: string;
  hasGitDir: boolean;
  user: string;
  sandbox: SandboxConfig;
  command: readonly string[];
}): string[] {
  const { kind, jobId, workspace, hasGitDir, user, sandbox, command } = options;
  const args = [
    kind === "job" ? "--detach" : "--rm",
    "--name",
    containerName(kind, jobId),
    "--label",
    `${LABEL}=1`,
    "--label",
    `sakura-factory.job-id=${jobId}`,
    "--label",
    `sakura-factory.kind=${kind}`,
    "--pull",
    "never",
    "--network",
    kind === "job" ? "none" : "bridge",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,size=${sandbox.tmp_size_mb}m`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(sandbox.pids_limit),
    "--memory",
    `${sandbox.memory_mb}m`,
    "--memory-swap",
    `${sandbox.memory_mb}m`,
    "--cpus",
    String(sandbox.cpus),
    "--user",
    user,
    "--env",
    "HOME=/tmp",
    "--init",
    "--volume",
    `${workspace}:${WORKSPACE}`,
  ];
  if (hasGitDir) args.push("--volume", `${workspace}/.git:${WORKSPACE}/.git:ro`);
  args.push("--workdir", WORKSPACE, sandbox.image, ...command);
  return args;
}
