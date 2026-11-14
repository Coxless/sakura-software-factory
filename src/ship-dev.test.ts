import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseConfig } from "./config.ts";
import { createBareRepo, FakeGitHub } from "./github/testing.ts";
import {
  EXIT_FAILED,
  EXIT_SHIPPED,
  EXIT_USAGE,
  parseShipDevArgs,
  runShipDevCli,
  UsageError,
} from "./ship-dev.ts";

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
);

const README_PATCH = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,3 @@",
  " # demo",
  "+",
  "+`pnpm run check` で検査する",
  "",
].join("\n");

function patchFile(text = README_PATCH): string {
  const path = join(mkdtempSync(join(tmpdir(), "factory-patch-")), "change.diff");
  writeFileSync(path, text);
  return path;
}

describe("parseShipDevArgs", () => {
  test("必須の引数と既定値", () => {
    const patch = patchFile();
    expect(parseShipDevArgs(["--", "--repo", "o/r", "--issue", "3", "--patch", patch])).toEqual({
      repo: "o/r",
      issue: 3,
      patch,
      workType: "docs",
      summary: "ship:dev による出荷の確認",
    });
  });

  test.each([
    [["--issue", "1", "--patch", "x"], "--repo"],
    [["--repo", "bad", "--issue", "1", "--patch", "x"], "--repo"],
    [["--repo", "o/r", "--issue", "0", "--patch", "x"], "--issue"],
    [["--repo", "o/r", "--issue", "1", "--patch", "/nonexistent.diff"], "--patch"],
  ])("誤り %j は %s のエラー", (argv, name) => {
    expect(() => parseShipDevArgs(argv)).toThrow(UsageError);
    expect(() => parseShipDevArgs(argv)).toThrow(name);
  });

  test("--work-type は作業の種類のどれか", () => {
    const patch = patchFile();
    expect(
      parseShipDevArgs([
        "--repo",
        "o/r",
        "--issue",
        "1",
        "--patch",
        patch,
        "--work-type",
        "feature",
      ]).workType,
    ).toBe("feature");
    expect(() =>
      parseShipDevArgs([
        "--repo",
        "o/r",
        "--issue",
        "1",
        "--patch",
        patch,
        "--work-type",
        "hotfix",
      ]),
    ).toThrow("--work-type");
  });
});

describe("runShipDevCli", () => {
  test("パッチを当てて出荷し、PR の URL と振り分けを出す（終了コード 0）。LLM の APIキーは要らない", async () => {
    const { baseUrl } = await createBareRepo();
    const github = new FakeGitHub();
    const out: string[] = [];
    const code = await runShipDevCli(
      ["--repo", "octo-org/demo", "--issue", "7", "--patch", patchFile()],
      {},
      {
        stdout: (t) => out.push(t),
        stderr: () => {},
        loadConfig: () => CONFIG,
        github,
        cloneBaseUrl: baseUrl,
      },
    );
    expect(code).toBe(EXIT_SHIPPED);
    expect(out.join("")).toContain("PR: https://github.com/octo-org/demo/pull/1");
    expect(out.join("")).toContain("decision: auto_merge");
    expect(out.join("")).toContain("status: ci_waiting");
    expect(github.pullRequests[0]?.head).toMatch(/^agent\/issue-7-job-1-ship-dev-\d+$/);
  });

  test("作業の種類が許可にないと Draft", async () => {
    const { baseUrl } = await createBareRepo();
    const github = new FakeGitHub();
    const out: string[] = [];
    const code = await runShipDevCli(
      ["--repo", "octo-org/demo", "--issue", "7", "--patch", patchFile(), "--work-type", "feature"],
      {},
      {
        stdout: (t) => out.push(t),
        stderr: () => {},
        loadConfig: () => CONFIG,
        github,
        cloneBaseUrl: baseUrl,
      },
    );
    expect(code).toBe(EXIT_SHIPPED);
    expect(out.join("")).toContain("decision: draft");
  });

  test("CI の定義を変えるパッチは push せず終了コード 1", async () => {
    const { baseUrl } = await createBareRepo();
    const github = new FakeGitHub();
    const out: string[] = [];
    const patch = patchFile(
      [
        "diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/.github/workflows/x.yml",
        "@@ -0,0 +1 @@",
        "+on: push",
        "",
      ].join("\n"),
    );
    const code = await runShipDevCli(
      ["--repo", "octo-org/demo", "--issue", "7", "--patch", patch],
      {},
      {
        stdout: (t) => out.push(t),
        stderr: () => {},
        loadConfig: () => CONFIG,
        github,
        cloneBaseUrl: baseUrl,
      },
    );
    expect(code).toBe(EXIT_FAILED);
    expect(out.join("")).toContain("failed: unshippable_change");
    expect(github.pullRequests).toEqual([]);
  });

  test("引数の誤り・App の環境変数がないと終了コード 2", async () => {
    const err: string[] = [];
    const io = { stdout: () => {}, stderr: (t: string) => err.push(t), loadConfig: () => CONFIG };
    expect(await runShipDevCli(["--repo", "bad"], {}, io)).toBe(EXIT_USAGE);
    expect(
      await runShipDevCli(["--repo", "o/r", "--issue", "1", "--patch", patchFile()], {}, io),
    ).toBe(EXIT_USAGE);
    expect(err.join("")).toContain("GITHUB_APP_ID");
  });
});
