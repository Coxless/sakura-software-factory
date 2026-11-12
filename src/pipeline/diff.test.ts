import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa, execaSync } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { gitDiffSource, listGitFiles, parseNumstat } from "./diff.ts";

function hasGit(): boolean {
  try {
    execaSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "diff-test-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execa("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  await git("init", "--quiet");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  await git("add", "-A");
  await git("commit", "--quiet", "-m", "init");
  return dir;
}

const status = async (dir: string) =>
  (await execa("git", ["-C", dir, "status", "--porcelain"])).stdout;

describe.skipIf(!hasGit())("gitDiffSource（git がなければ飛ばす）", () => {
  test("変更・追跡していない新しいファイル・削除が diff に入り、数が合う。インデックスは変わらない", async () => {
    const dir = await repo({ "a.txt": "1\n2\n", "b.txt": "x\n" });
    const base = await gitDiffSource.base(dir);
    expect(base).toBe((await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim());

    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    unlinkSync(join(dir, "b.txt"));
    const before = await status(dir);

    const { diff, stat } = await gitDiffSource.diff(dir, base);
    expect(diff).toContain("+3");
    expect(diff).toContain("new.txt");
    expect(diff).toContain("deleted file mode");
    expect(stat).toEqual({ files: 3, insertions: 2, deletions: 1 });
    expect(await status(dir)).toBe(before);
    expect((await execa("git", ["-C", dir, "diff", "--cached", "--name-only"])).stdout).toBe("");
  });

  test("変更がなければ空の diff と 0", async () => {
    const dir = await repo({ "a.txt": "1\n" });
    const base = await gitDiffSource.base(dir);
    expect(await gitDiffSource.diff(dir, base)).toEqual({
      diff: "",
      stat: { files: 0, insertions: 0, deletions: 0 },
    });
  });

  test("listGitFiles は追跡しているファイルの一覧", async () => {
    const dir = await repo({ "a.txt": "1\n", "b.txt": "2\n" });
    writeFileSync(join(dir, "untracked.txt"), "u\n");
    expect(await listGitFiles(dir)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("parseNumstat", () => {
  test("バイナリの - は 0 として数える", () => {
    expect(parseNumstat("1\t2\ta.txt\n-\t-\timg.png\n")).toEqual({
      files: 2,
      insertions: 1,
      deletions: 2,
    });
  });
});
