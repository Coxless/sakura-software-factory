import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeReadableByOthers } from "./readable.ts";

const mode = (p: string) => statSync(p).mode & 0o777;

describe("makeReadableByOthers", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("UMask=0027 で作られたファイルとディレクトリを、ほかのユーザーから読めるようにする", () => {
    root = mkdtempSync(join(tmpdir(), "readable-"));
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(src, "server.js"), "");
    writeFileSync(join(root, "run.sh"), "");
    chmodSync(join(root, "package.json"), 0o640);
    chmodSync(join(src, "server.js"), 0o600);
    chmodSync(join(root, "run.sh"), 0o750);
    chmodSync(src, 0o750);
    chmodSync(root, 0o750);

    makeReadableByOthers(root);

    expect(mode(root)).toBe(0o755);
    expect(mode(src)).toBe(0o755);
    expect(mode(join(root, "package.json"))).toBe(0o644);
    expect(mode(join(src, "server.js"))).toBe(0o644);
    expect(mode(join(root, "run.sh"))).toBe(0o754);
  });

  it(".git には触れず、シンボリックリンクの先も変えない", () => {
    root = mkdtempSync(join(tmpdir(), "readable-"));
    const git = join(root, ".git");
    mkdirSync(git);
    writeFileSync(join(git, "config"), "");
    chmodSync(join(git, "config"), 0o600);
    const outside = mkdtempSync(join(tmpdir(), "readable-outside-"));
    const target = join(outside, "secret");
    writeFileSync(target, "");
    chmodSync(target, 0o600);
    symlinkSync(target, join(root, "link"));

    makeReadableByOthers(root);

    expect(mode(join(git, "config"))).toBe(0o600);
    expect(mode(target)).toBe(0o600);
    rmSync(outside, { recursive: true, force: true });
  });
});
