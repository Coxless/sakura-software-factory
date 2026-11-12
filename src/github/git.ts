import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execa } from "execa";
import { maskSecrets, REDACTED } from "../trace/mask.ts";

/** git を1回実行する。テストでは呼び出しを記録する偽物に差し替える */
export type GitRunner = (
  args: readonly string[],
  options: { env: Record<string, string | undefined>; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: GitRunner = (args, options) =>
  execa("git", args, {
    env: options.env,
    extendEnv: false,
    ...(options.signal ? { cancelSignal: options.signal } : {}),
  });

/** 取得・作業ブランチの作成に失敗した。message はトークンを伏せ済み */
export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneError";
  }
}

/** 呼び出し元の環境から、git の設定を差し込む変数を取り除いた環境（取り違えを防ぐ） */
function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_CONFIG_")) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * インストールトークンで既定のブランチを浅く取得し、作業ブランチを作る（research R8、FR-018・FR-019）。
 * トークンは clone の子プロセスの環境変数（GIT_CONFIG_COUNT・GIT_CONFIG_KEY_0・GIT_CONFIG_VALUE_0）でだけ渡す。
 * コマンドラインの引数（/proc/<pid>/cmdline から見える）・リモートの URL・.git/config には入れない。
 */
export async function cloneForJob(req: {
  repo: string;
  token: string;
  defaultBranch: string;
  dir: string;
  branch: string;
  signal?: AbortSignal;
  /** 既定は https://github.com。テストでは file:// */
  baseUrl?: string;
  run?: GitRunner;
}): Promise<void> {
  const run = req.run ?? defaultRunner;
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${req.token}`).toString("base64")}`;
  const secrets = [req.token, header, header.slice("AUTHORIZATION: basic ".length)];
  const mask = (text: string) => {
    let masked = maskSecrets(text);
    for (const secret of secrets) masked = masked.split(secret).join(REDACTED);
    return masked;
  };
  const url = `${req.baseUrl ?? "https://github.com"}/${req.repo}.git`;
  const signal = req.signal ? { signal: req.signal } : {};

  try {
    if (req.signal?.aborted) throw req.signal.reason ?? new Error("中断しました");
    mkdirSync(dirname(req.dir), { recursive: true });
    await run(
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        req.defaultBranch,
        url,
        req.dir,
      ],
      {
        env: {
          ...baseEnv(),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: header,
        },
        ...signal,
      },
    );
    await run(["-C", req.dir, "switch", "--quiet", "-c", req.branch], {
      env: baseEnv(),
      ...signal,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new CloneError(mask(`${req.repo} を取得できません: ${text}`));
  }
}
