import { describe, expect, test } from "vitest";
import { matchDenied, resolveWorkspacePath, toRelative } from "./paths.ts";

describe("resolveWorkspacePath", () => {
  test.each([
    ["a/b.ts", "a/b.ts"],
    ["./a", "a"],
    ["/workspace/a", "a"],
    ["a/../b", "b"],
    ["a//b/", "a/b"],
  ])("%s は作業ディレクトリの中（%s）", (input, relative) => {
    expect(resolveWorkspacePath(input)).toEqual({
      kind: "inside",
      absolute: `/workspace/${relative}`,
      relative,
    });
  });

  test.each(["../x", "/etc/passwd", "a/../../x", "/workspace2/a", "/workspace/../etc"])(
    "%s は外側",
    (input) => {
      expect(resolveWorkspacePath(input).kind).toBe("outside");
    },
  );

  test.each(["", ".", "/workspace", "/workspace/", "a/.."])(
    "%s は作業ディレクトリそのもの",
    (input) => {
      expect(resolveWorkspacePath(input)).toEqual({ kind: "root" });
    },
  );
});

describe("toRelative", () => {
  test("中なら相対パス、外なら undefined", () => {
    expect(toRelative("/workspace/a/b")).toBe("a/b");
    expect(toRelative("/etc/passwd")).toBeUndefined();
    expect(toRelative("/workspace")).toBeUndefined();
  });
});

describe("matchDenied", () => {
  test("一致した規則を返す", () => {
    expect(matchDenied("pnpm-lock.yaml", ["**/pnpm-lock.yaml"])).toBe("**/pnpm-lock.yaml");
    expect(matchDenied("src/a.ts", ["**/pnpm-lock.yaml"])).toBeUndefined();
  });
});
