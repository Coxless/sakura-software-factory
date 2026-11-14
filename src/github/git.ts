import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { maskSecrets, REDACTED } from "../trace/mask.ts";

/** git を1回実行する。テストでは呼び出しを記録する偽物に差し替える */
export type GitRunner = (
  args: readonly string[],
  options: { env: Record<string, string | undefined>; signal?: AbortSignal; input?: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: GitRunner = (args, options) =>
  execa("git", args, {
    env: options.env,
    extendEnv: false,
    ...(options.input === undefined ? {} : { input: options.input }),
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

/** トークンを http.extraHeader として git に渡す環境変数と、エラーの文からトークンを伏せる関数 */
function tokenAccess(token: string): {
  env: Record<string, string>;
  mask: (text: string) => string;
} {
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const secrets = [token, header, header.slice("AUTHORIZATION: basic ".length)];
  return {
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: header,
    },
    mask: (text: string) => {
      let masked = maskSecrets(text);
      for (const secret of secrets) masked = masked.split(secret).join(REDACTED);
      return masked;
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const access = tokenAccess(req.token);
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
        env: { ...baseEnv(), ...access.env },
        ...signal,
      },
    );
    await run(["-C", req.dir, "switch", "--quiet", "-c", req.branch], {
      env: baseEnv(),
      ...signal,
    });
  } catch (error) {
    throw new CloneError(access.mask(`${req.repo} を取得できません: ${errorText(error)}`));
  }
}

// ---- 008: commit と push（research R2・R5） ----

/** commit・push で失敗した。message はトークンを伏せ済み */
export class ShipGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipGitError";
  }
}

/**
 * 作業ディレクトリのフックとコードを実行させうる設定、ホストのユーザーの設定を使わずに git を呼ぶための引数と環境。
 * .git/config は 007 の clone でホストが作り、作業場からは読み取り専用なので、ここで外すのは念のための層
 */
const SAFE_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "core.quotePath=false",
];

async function withSafeEnv<T>(
  fn: (env: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "factory-git-home-"));
  try {
    return await fn({
      ...baseEnv(),
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 作業ディレクトリの変更（005 の diff と同じ範囲: 追跡していない新しいファイルを含み .gitignore に従う）を
 * 1つの commit にする。作成者とコミッターは App のボット。変更がなければ undefined。トークンは使わない
 */
export async function commitForJob(req: {
  dir: string;
  message: string;
  author: { name: string; email: string };
  run?: GitRunner;
}): Promise<{ base: string; head: string } | undefined> {
  const run = req.run ?? defaultRunner;
  try {
    return await withSafeEnv(async (env) => {
      const git = (...args: string[]) => run(["-C", req.dir, ...SAFE_CONFIG, ...args], { env });
      const base = (await git("rev-parse", "HEAD")).stdout.trim();
      await git("add", "-A");
      const staged = (await git("diff", "--cached", "--name-only")).stdout.trim();
      if (staged === "") return undefined;
      await run(["-C", req.dir, ...SAFE_CONFIG, "commit", "--quiet", "--no-verify", "-F", "-"], {
        env: {
          ...env,
          GIT_AUTHOR_NAME: req.author.name,
          GIT_AUTHOR_EMAIL: req.author.email,
          GIT_COMMITTER_NAME: req.author.name,
          GIT_COMMITTER_EMAIL: req.author.email,
        },
        input: req.message,
      });
      const head = (await git("rev-parse", "HEAD")).stdout.trim();
      return { base, head };
    });
  } catch (error) {
    throw new ShipGitError(maskSecrets(`commit できません: ${errorText(error)}`));
  }
}

export interface ChangedFile {
  path: string;
  /** 名前の変更・コピーの変更前のパス */
  oldPath?: string;
  /** git の状態の文字（A・M・D・R・C・T） */
  status: string;
}

/** <base>..<head> の変更したパス（名前の変更・コピーは変更前と変更後の両方）と行数（バイナリは数えない） */
export async function changedFiles(req: {
  dir: string;
  base: string;
  head: string;
  run?: GitRunner;
}): Promise<{
  paths: string[];
  files: ChangedFile[];
  insertions: number;
  deletions: number;
  binary: number;
}> {
  const run = req.run ?? defaultRunner;
  return withSafeEnv(async (env) => {
    const git = (...args: string[]) => run(["-C", req.dir, ...SAFE_CONFIG, ...args], { env });
    const nameStatus = (await git("diff", "--name-status", "-M", "-z", req.base, req.head)).stdout;
    const parts = nameStatus.split("\0").filter((part) => part !== "");
    const files: ChangedFile[] = [];
    for (let i = 0; i < parts.length; ) {
      const code = parts[i++] ?? "";
      const status = code.charAt(0);
      if (status === "R" || status === "C") {
        const oldPath = parts[i++] ?? "";
        const path = parts[i++] ?? "";
        files.push({ path, oldPath, status });
      } else {
        files.push({ path: parts[i++] ?? "", status });
      }
    }
    const paths = [...new Set(files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])))];
    const numstat = (await git("diff", "--numstat", "-M", req.base, req.head)).stdout;
    let insertions = 0;
    let deletions = 0;
    let binary = 0;
    for (const line of numstat.split("\n")) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!match) continue;
      if (match[1] === "-" && match[2] === "-") binary += 1;
      insertions += match[1] === "-" ? 0 : Number(match[1]);
      deletions += match[2] === "-" ? 0 : Number(match[2]);
    }
    return { paths, files, insertions, deletions, binary };
  });
}

/**
 * 作業ブランチだけを push する（強制しない）。トークンは環境変数で渡し、リモートの URL は
 * `<baseUrl>/<repo>.git` を明示する（作業ディレクトリの remote の設定に頼らない）
 */
export async function pushBranch(req: {
  dir: string;
  repo: string;
  token: string;
  branch: string;
  signal?: AbortSignal;
  /** 既定は https://github.com。テストでは file:// */
  baseUrl?: string;
  run?: GitRunner;
}): Promise<void> {
  const run = req.run ?? defaultRunner;
  const access = tokenAccess(req.token);
  const url = `${req.baseUrl ?? "https://github.com"}/${req.repo}.git`;
  try {
    await withSafeEnv((env) =>
      run(
        [
          "-C",
          req.dir,
          ...SAFE_CONFIG,
          "push",
          "--quiet",
          "--no-verify",
          url,
          `HEAD:refs/heads/${req.branch}`,
        ],
        { env: { ...env, ...access.env }, ...(req.signal ? { signal: req.signal } : {}) },
      ),
    );
  } catch (error) {
    throw new ShipGitError(access.mask(`${req.branch} を push できません: ${errorText(error)}`));
  }
}
