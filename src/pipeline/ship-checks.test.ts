import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import {
  evaluateShipChecks,
  findInlineAllows,
  type SecretScan,
  scanSecrets,
} from "./ship-checks.ts";

const CONFIG = parseConfig(
  `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"
[models]
planner = "p"
implementer = "i"
verifier = "v"
fallback = "f"
[budget]
monthly_requests = 100
per_job_requests = 10
[github]
allowed_users = ["octo-requester"]
`,
  "/srv/factory",
).auto_merge;

/** 本物の形の偽の GitHub トークン（ソースに固定の値を書かない） */
function fakeGithubToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(36);
  return `ghp_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

const ALL_MET = {
  config: CONFIG,
  verdictPassed: true,
  workType: "docs" as const,
  changes: { paths: ["README.md"], insertions: 3, deletions: 1 },
  secrets: { status: "clean" } as SecretScan,
  labels: { names: ["documentation"] },
};

describe("evaluateShipChecks", () => {
  test("すべて満たせば unmet は空で push してよい", () => {
    const result = evaluateShipChecks(ALL_MET);
    expect(result.unmet).toEqual([]);
    expect(result.blocker).toBeNull();
    expect(result.conditions.map((c) => c.name)).toEqual([
      "verdict",
      "diff_size",
      "forbidden_paths",
      "secrets",
      "skip_label",
      "work_type",
    ]);
    expect(result.conditions.every((c) => c.met)).toBe(true);
    expect(result.conditions[1]).toEqual({
      name: "diff_size",
      met: true,
      value: { lines: 4, max: 300 },
    });
  });

  test.each([
    ["verdict", { verdictPassed: false }],
    ["diff_size", { changes: { paths: ["a"], insertions: 300, deletions: 1 } }],
    ["forbidden_paths", { changes: { paths: ["pnpm-lock.yaml"], insertions: 1, deletions: 0 } }],
    ["forbidden_paths", { changes: { paths: ["deploy/setup.sh"], insertions: 1, deletions: 0 } }],
    ["forbidden_paths", { changes: { paths: [".gitleaks.toml"], insertions: 1, deletions: 0 } }],
    ["skip_label", { labels: { names: ["No-Auto-Merge"] } }],
    ["skip_label", { labels: { error: "502" } }],
    ["work_type", { workType: "feature" as const }],
    ["work_type", { workType: undefined }],
  ] as const)("%s だけを外す（%j）", (name, override) => {
    const result = evaluateShipChecks({ ...ALL_MET, ...override });
    expect(result.unmet).toEqual([name]);
    expect(result.blocker).toBeNull();
  });

  test("diff はちょうど上限なら満たす", () => {
    const result = evaluateShipChecks({
      ...ALL_MET,
      changes: { paths: ["a"], insertions: 200, deletions: 100 },
    });
    expect(result.unmet).toEqual([]);
  });

  test.each([
    { status: "found", findings: [{ file: "a.ts", line: 1, rule: "github-pat" }] },
    { status: "unavailable", error: "gitleaks がない" },
  ] as const)("秘密情報（%j）は secret_detected で push しない", (secrets) => {
    const result = evaluateShipChecks({ ...ALL_MET, secrets: secrets as unknown as SecretScan });
    expect(result.unmet).toEqual(["secrets"]);
    expect(result.blocker).toBe("secret_detected");
  });

  test("複数を外すと6条件の順ですべて unmet に入る", () => {
    const result = evaluateShipChecks({
      ...ALL_MET,
      workType: "feature",
      labels: { names: ["no-auto-merge"] },
      changes: { paths: ["deploy/x.sh"], insertions: 500, deletions: 0 },
    });
    expect(result.unmet).toEqual(["diff_size", "forbidden_paths", "skip_label", "work_type"]);
  });

  test("CI の定義の変更は unshippable_change（禁止パスの設定から外しても）", () => {
    const changes = { paths: [".github/workflows/ci.yml"], insertions: 1, deletions: 0 };
    expect(evaluateShipChecks({ ...ALL_MET, changes }).blocker).toBe("unshippable_change");
    const loose = { ...CONFIG, forbidden_paths: ["deploy/**"] };
    expect(evaluateShipChecks({ ...ALL_MET, config: loose, changes }).blocker).toBe(
      "unshippable_change",
    );
  });

  test("名前の変更の変更前のパスが CI の定義でも unshippable_change", () => {
    const changes = {
      paths: [".github/workflows/ci.yml", "docs/ci.yml"],
      insertions: 0,
      deletions: 0,
    };
    expect(evaluateShipChecks({ ...ALL_MET, changes }).blocker).toBe("unshippable_change");
  });

  test("秘密情報と CI の定義の両方なら secret_detected を優先", () => {
    const result = evaluateShipChecks({
      ...ALL_MET,
      secrets: { status: "unavailable", error: "x" },
      changes: { paths: [".github/workflows/ci.yml"], insertions: 1, deletions: 0 },
    });
    expect(result.blocker).toBe("secret_detected");
  });

  test("禁止パスの値に当たったパスと規則が入る", () => {
    const result = evaluateShipChecks({
      ...ALL_MET,
      changes: { paths: ["README.md", "deploy/a.sh"], insertions: 1, deletions: 0 },
    });
    expect(result.conditions[2]).toEqual({
      name: "forbidden_paths",
      met: false,
      value: { matched: [{ path: "deploy/a.sh", pattern: "deploy/**" }] },
    });
  });
});

describe("findInlineAllows", () => {
  test("追加行の gitleaks:allow だけを見つける", () => {
    const diff = [
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1,2 +1,3 @@",
      " const x = 1; // gitleaks:allow",
      "-const y = 2; // gitleaks:allow",
      '+const token = "x"; // gitleaks:allow',
      "diff --git a/b.js b/b.js",
      "--- /dev/null",
      "+++ b/b.js",
      "@@ -0,0 +1,2 @@",
      "+ok",
      "+// gitleaks:allow",
    ].join("\n");
    expect(findInlineAllows(diff)).toEqual([
      { file: "a.js", line: 2 },
      { file: "b.js", line: 2 },
    ]);
  });
});

/** base の commit と、その上の1つの commit を持つ一時リポジトリ */
async function repoWith(
  baseFiles: Record<string, string>,
  headFiles: Record<string, string>,
): Promise<{ dir: string; base: string; head: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-scan-"));
  const git = (...args: string[]) =>
    execa("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args]);
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  await git("init", "--quiet", "--initial-branch=main");
  write({ "README.md": "# demo\n", ...baseFiles });
  await git("add", "-A");
  await git("commit", "-qm", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  write(headFiles);
  await git("add", "-A");
  await git("commit", "-qm", "head");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  return { dir, base, head };
}

const ALLOW_FILE = (path: string, value: string) =>
  `[extend]\nuseDefault = true\n[[allowlists]]\ncondition = "AND"\npaths = ['''^${path.replace(".", "\\.")}$''']\nregexes = ['''^${value}$''']\n`;

describe("scanSecrets（本物の gitleaks）", () => {
  test("秘密情報がなければ clean", async () => {
    const r = await repoWith({}, { "a.txt": "hello\n" });
    expect(await scanSecrets({ ...r, timeoutMs: 60_000 })).toEqual({ status: "clean" });
  });

  test("本物の形のトークンは found で、値はどこにも入らない", async () => {
    const token = fakeGithubToken();
    const r = await repoWith({}, { "src/leak.js": `const token = "${token}";\n` });
    const result = await scanSecrets({ ...r, timeoutMs: 60_000 });
    expect(result).toEqual({
      status: "found",
      findings: [{ file: "src/leak.js", line: 1, rule: "github-pat" }],
    });
    expect(JSON.stringify(result)).not.toContain(token.slice(4));
  });

  test("同じ commit で足した .gitleaks.toml・.gitleaksignore の許可は効かない", async () => {
    const token = fakeGithubToken();
    const r = await repoWith(
      {},
      {
        "leak.js": `const token = "${token}";\n`,
        ".gitleaks.toml": ALLOW_FILE("leak.js", token),
        ".gitleaksignore": "leak.js:github-pat:1\n",
      },
    );
    expect((await scanSecrets({ ...r, timeoutMs: 60_000 })).status).toBe("found");
  });

  test("基準のコミットの .gitleaks.toml の許可には従う", async () => {
    const token = fakeGithubToken();
    const r = await repoWith(
      { ".gitleaks.toml": ALLOW_FILE("fixture.js", token) },
      { "fixture.js": `const token = "${token}";\n` },
    );
    expect(await scanSecrets({ ...r, timeoutMs: 60_000 })).toEqual({ status: "clean" });
  });

  test("基準のコミットの .gitleaksignore（<file>:<rule>:<line> の形）には従う", async () => {
    const token = fakeGithubToken();
    const r = await repoWith(
      { ".gitleaksignore": "fixture.js:github-pat:1\n" },
      { "fixture.js": `const token = "${token}";\n` },
    );
    expect(await scanSecrets({ ...r, timeoutMs: 60_000 })).toEqual({ status: "clean" });
  });

  test("存在しない基準のコミット（走査 0）は unavailable", async () => {
    const r = await repoWith({}, { "a.txt": "x\n" });
    const result = await scanSecrets({ ...r, base: "0".repeat(40), timeoutMs: 60_000 });
    expect(result.status).toBe("unavailable");
  });

  test("gitleaks が見つからなければ unavailable", async () => {
    const r = await repoWith({}, { "a.txt": "x\n" });
    const result = await scanSecrets({
      ...r,
      timeoutMs: 60_000,
      gitleaksPath: "/nonexistent/gitleaks",
    });
    expect(result.status).toBe("unavailable");
  });

  test("時間の上限を過ぎたら unavailable", async () => {
    const r = await repoWith({}, { "a.txt": "x\n" });
    const result = await scanSecrets({ ...r, timeoutMs: 1 });
    expect(result.status).toBe("unavailable");
  });
});
