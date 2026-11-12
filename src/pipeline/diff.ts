/**
 * diff の取り出し（005 research R6）。ホストの git で、工程の開始時のコミットからの全変更を取る。
 * 一時的なインデックス（GIT_INDEX_FILE）を使い、作業ディレクトリのインデックスと作業ツリーは変えない。
 * 追跡していない新しいファイルも含める（FR-022）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface DiffSource {
  /** 基準のコミットを覚える（工程の開始時） */
  base(workdir: string): Promise<string>;
  /** 基準からの全変更。インデックスと作業ツリーは変えない */
  diff(workdir: string, base: string): Promise<{ diff: string; stat: DiffStat }>;
}

/** git の設定やフックに左右されないよう、ホストの git を最小の環境で呼ぶ */
async function git(workdir: string, args: string[], env: Record<string, string> = {}) {
  const result = await execa("git", ["-C", workdir, "-c", "core.quotePath=false", ...args], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    stripFinalNewline: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

/** `git diff --numstat` の出力を数える（バイナリの "-" は 0 として数える） */
export function parseNumstat(text: string): DiffStat {
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
  for (const line of text.split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) continue;
    stat.files += 1;
    stat.insertions += match[1] === "-" ? 0 : Number(match[1]);
    stat.deletions += match[2] === "-" ? 0 : Number(match[2]);
  }
  return stat;
}

export const gitDiffSource: DiffSource = {
  async base(workdir) {
    return (await git(workdir, ["rev-parse", "HEAD"])).trim();
  },
  async diff(workdir, base) {
    const dir = mkdtempSync(join(tmpdir(), "factory-diff-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      await git(workdir, ["read-tree", base], env);
      await git(workdir, ["add", "-A"], env);
      const diff = await git(
        workdir,
        ["diff", "--cached", "--no-color", "--no-ext-diff", base],
        env,
      );
      const numstat = await git(workdir, ["diff", "--cached", "--numstat", base], env);
      return { diff, stat: parseNumstat(numstat) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/** 追跡しているファイルの一覧（計画役に渡す） */
export async function listGitFiles(workdir: string): Promise<string[]> {
  const out = await git(workdir, ["ls-files"]);
  return out.split("\n").filter((line) => line !== "");
}
