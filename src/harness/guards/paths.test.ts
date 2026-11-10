import { describe, expect, test } from "vitest";
import { DEFAULT_DENY_WRITE_PATHS } from "../../config.ts";
import { createPathGuard } from "./paths.ts";

/** 偽の realpath: links に載っているパスはその先に、それ以外はそのまま */
function fakeRealpath(links: Record<string, string> = {}) {
  return async (path: string) => links[path] ?? path;
}

function guardWith(links?: Record<string, string>) {
  return createPathGuard({
    denyWritePaths: DEFAULT_DENY_WRITE_PATHS,
    resolveRealPath: fakeRealpath(links),
  });
}

const write = (path: string) => ({ toolName: "write_file", args: { path, content: "x" } });
const edit = (path: string) => ({
  toolName: "edit_file",
  args: { path, old_string: "a", new_string: "b" },
});
const read = (path: string) => ({ toolName: "read_file", args: { path } });

describe("createPathGuard: 作業ディレクトリの外", () => {
  test.each(["/etc/passwd", "../x", "a/../../x"])("%s は読み書きとも拒否", async (path) => {
    const guard = guardWith();
    for (const call of [read(path), write(path), edit(path)]) {
      const decision = await guard(call);
      expect(decision?.block).toBe(true);
      expect(decision?.guard).toBe("path");
      expect(decision?.reason).toContain("作業ディレクトリの外");
    }
  });
});

describe("createPathGuard: 禁止パス", () => {
  test.each([
    [".git", ".git"],
    [".git/hooks/pre-commit", ".git/**"],
    ["packages/a/.git/config", "**/.git/**"],
    [".github/workflows/ci.yml", ".github/workflows/**"],
    [".env", ".env*"],
    ["apps/web/.env.local", "**/.env*"],
    ["pnpm-lock.yaml", "**/pnpm-lock.yaml"],
    ["packages/a/package-lock.json", "**/package-lock.json"],
    ["yarn.lock", "**/yarn.lock"],
    ["deploy/staging/compose.yaml", "deploy/**"],
  ])("%s への書き込み・置換を拒否（規則 %s）", async (path, rule) => {
    const guard = guardWith();
    for (const call of [write(path), edit(path)]) {
      const decision = await guard(call);
      expect(decision?.block).toBe(true);
      expect(decision?.reason).toContain(`一致した規則: ${rule}`);
      expect(decision?.reason).toContain("変更できません");
    }
  });

  test("禁止パスでも読むのは許可", async () => {
    expect(await guardWith()(read(".github/workflows/ci.yml"))).toBeUndefined();
    expect(await guardWith()(read("pnpm-lock.yaml"))).toBeUndefined();
  });

  test("/workspace/ で始まる絶対パスでも禁止パスを拒否", async () => {
    expect((await guardWith()(write("/workspace/.github/workflows/ci.yml")))?.block).toBe(true);
  });
});

describe("createPathGuard: シンボリックリンク", () => {
  test("リンクの先が禁止パスなら書き込みを拒否", async () => {
    const guard = guardWith({ "/workspace/ci.yml": "/workspace/.github/workflows/ci.yml" });
    const decision = await guard(write("ci.yml"));
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("実際のパスは .github/workflows/ci.yml");
  });

  test("リンクの先が作業ディレクトリの外なら読み書きとも拒否", async () => {
    const guard = guardWith({ "/workspace/passwd": "/etc/passwd" });
    for (const call of [read("passwd"), write("passwd")]) {
      const decision = await guard(call);
      expect(decision?.block).toBe(true);
      expect(decision?.reason).toContain("/etc/passwd");
    }
  });

  test("リンクの先が作業ディレクトリの中の普通のファイルなら許可", async () => {
    const guard = guardWith({
      "/workspace/node_modules/.bin/tsc": "/workspace/node_modules/typescript/bin/tsc",
    });
    expect(await guard(read("node_modules/.bin/tsc"))).toBeUndefined();
  });
});

describe("createPathGuard: 許可と素通し", () => {
  test.each([
    "src/a.ts",
    "README.md",
    ".github/ISSUE_TEMPLATE/bug.md",
    "docs/env.md",
    "src/.gitignore",
  ])("%s は読み書きとも許可", async (path) => {
    const guard = guardWith();
    for (const call of [read(path), write(path), edit(path)]) {
      expect(await guard(call)).toBeUndefined();
    }
  });

  test("bash は素通し", async () => {
    expect(
      await guardWith()({ toolName: "bash", args: { command: "cat /etc/passwd" } }),
    ).toBeUndefined();
  });

  test("path の形が違う呼び出しは素通し（ツール側の引数の検証に任せる）", async () => {
    expect(await guardWith()({ toolName: "read_file", args: {} })).toBeUndefined();
    expect(await guardWith()({ toolName: "write_file", args: null })).toBeUndefined();
  });

  test("作業ディレクトリそのものは素通し（ツール側でディレクトリのエラーにする）", async () => {
    expect(await guardWith()(read("."))).toBeUndefined();
  });
});
