import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryConfig } from "./config.ts";
import { createLlmModels } from "./llm/provider.ts";
import { createTestGateDeps, type FakeResponse, TEST_API_KEY, TEST_NOW } from "./llm/testing.ts";
import {
  createFakeDiffSource,
  createFakeWorkspace,
  type FakeBashBehavior,
  textResponse,
  toolCallResponse,
} from "./pipeline/testing.ts";
import {
  EXIT_ERROR,
  EXIT_FAILED,
  EXIT_PASSED,
  EXIT_REJECTED,
  exitCodeOf,
  PUBLIC_DATA_NOTICE,
  parseIssueFile,
  parsePipelineDevArgs,
  runPipelineDevCli,
  UsageError,
} from "./pipeline-dev.ts";
import { jobs } from "./queue/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PLAN = {
  summary: "README に1行足す",
  steps: ["README.md を書き換える"],
  acceptance_criteria: ["README.md に1行増える"],
  work_type: "docs",
};
const PASS = { verdict: "pass", reasons: "満たしている", criteria: [] };
const FAIL = { verdict: "fail", reasons: "足りない", criteria: [] };

function files(issue = "README を直す\nREADME に1行足してください") {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-dev-"));
  dirs.push(dir);
  writeFileSync(join(dir, "issue.md"), issue);
  writeFileSync(join(dir, "plan.md"), "1. README.md に1行足す");
  return { dir, issue: join(dir, "issue.md"), plan: join(dir, "plan.md") };
}

describe("parsePipelineDevArgs", () => {
  test("必須の引数と任意の引数を読む", () => {
    expect(
      parsePipelineDevArgs([
        "--",
        "--repo",
        "/r",
        "--issue",
        "i.md",
        "--instruction",
        "c.md",
        "--plan",
        "p.md",
        "--install",
        "pnpm install --frozen-lockfile",
        "--max-turns",
        "5",
        "--timeout-minutes",
        "10",
        "--allow-sakura",
        "--json",
      ]),
    ).toEqual({
      repo: "/r",
      issue: "i.md",
      instruction: "c.md",
      plan: "p.md",
      install: "pnpm install --frozen-lockfile",
      maxTurns: 5,
      timeoutMinutes: 10,
      allowSakura: true,
      json: true,
    });
    expect(parsePipelineDevArgs(["--repo", "/r", "--issue", "i"])).toEqual({
      repo: "/r",
      issue: "i",
      allowSakura: false,
      json: false,
    });
  });

  test("必須の引数がない・未知の引数・数の誤りはエラー", () => {
    expect(() => parsePipelineDevArgs(["--repo", "/r"])).toThrow(/--issue/);
    expect(() => parsePipelineDevArgs(["--repo", "/r", "--issue", "i", "--x"])).toThrow(UsageError);
    expect(() =>
      parsePipelineDevArgs(["--repo", "/r", "--issue", "i", "--max-turns", "0"]),
    ).toThrow(/--max-turns/);
    expect(() =>
      parsePipelineDevArgs(["--repo", "/r", "--issue", "i", "--timeout-minutes", "1.5"]),
    ).toThrow(/--timeout-minutes/);
  });
});

describe("parseIssueFile と exitCodeOf", () => {
  test("1行目がタイトル、残りが本文", () => {
    expect(parseIssueFile("タイトル\n\n本文1\n本文2\n")).toEqual({
      title: "タイトル",
      body: "本文1\n本文2",
    });
    expect(parseIssueFile("1行だけ")).toEqual({ title: "1行だけ", body: "" });
  });

  test("passed → 0、rejected → 1、そのほか → 3", () => {
    expect(exitCodeOf({ outcome: "passed" })).toBe(EXIT_PASSED);
    expect(exitCodeOf({ outcome: "rejected" })).toBe(EXIT_REJECTED);
    for (const outcome of ["failed", "budget_exceeded", "timeout", "aborted"] as const) {
      expect(exitCodeOf({ outcome })).toBe(EXIT_FAILED);
    }
  });
});

function harness(
  responses: FakeResponse[],
  provider: "sakura" | "google-ai-studio",
  options: {
    exec?: (command: string) => FakeBashBehavior;
    prepareFails?: boolean;
    onHang?: () => void;
  } = {},
) {
  const traceDir = mkdtempSync(join(tmpdir(), "pipeline-dev-trace-"));
  dirs.push(traceDir);
  const setup = createTestGateDeps({
    responses,
    config: { storage: { trace_dir: traceDir }, limits: { judge_retries: 0 } },
    ...(options.onHang ? { onHang: options.onHang } : {}),
  });
  const config = {
    ...setup.deps.config,
    llm: { ...setup.deps.config.llm, provider },
  } as FactoryConfig;
  const deps = { ...setup.deps, config, models: createLlmModels(config) };
  const initial = { "README.md": "# demo\n" };
  const workspace = createFakeWorkspace(
    { ...initial },
    { config, ...(options.exec ? { exec: options.exec } : {}) },
  );
  const out: string[] = [];
  const err: string[] = [];
  let prepared = false;
  let closed = 0;
  const io = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    loadConfig: () => config,
    createDeps: () => ({ deps, close: () => {} }),
    prepare: async () => {
      prepared = true;
      if (options.prepareFails) throw new Error("clone できません");
      return {
        workspace,
        dir: "/tmp/fake/repo",
        diff: createFakeDiffSource(workspace, initial),
        listFiles: async () => ["README.md"],
        diffStat: async () => " README.md | 1 +",
        close: async () => {
          closed += 1;
        },
      };
    },
    now: () => TEST_NOW,
  };
  return {
    setup,
    io,
    out,
    err,
    workspace,
    prepared: () => prepared,
    closed: () => closed,
  };
}

const edit = () =>
  toolCallResponse("edit_file", {
    path: "README.md",
    old_string: "# demo",
    new_string: "# demo\npipeline:dev で試せる",
  });

describe("runPipelineDevCli（US5）", () => {
  test("さくらの設定では --allow-sakura がなければ 2 で止まり、何も用意しない", async () => {
    const h = harness([textResponse("done")], "sakura");
    const f = files();
    const code = await runPipelineDevCli(
      ["--repo", f.dir, "--issue", f.issue],
      { SAKURA_AI_API_KEY: TEST_API_KEY },
      h.io,
    );
    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("")).toContain("--allow-sakura");
    expect(h.prepared()).toBe(false);
    expect(h.setup.fake.requests).toHaveLength(0);
  });

  test("開発用の設定: 公開データの注意を出し、計画から判定まで通して 0。片付ける", async () => {
    const h = harness(
      [
        { text: JSON.stringify(PLAN) },
        edit(),
        textResponse("足しました"),
        { text: JSON.stringify(PASS) },
      ],
      "google-ai-studio",
    );
    const f = files();
    const code = await runPipelineDevCli(
      ["--repo", f.dir, "--issue", f.issue],
      { GEMINI_API_KEY: TEST_API_KEY },
      h.io,
    );
    const stderr = h.err.join("");
    expect(stderr).toContain(PUBLIC_DATA_NOTICE.trim());
    expect(stderr).toContain("[planning] round 0");
    expect(stderr).toContain("[judging] round 1");
    expect(code).toBe(EXIT_PASSED);
    const text = h.out.join("");
    expect(text).toContain("provider: google-ai-studio");
    expect(text).toContain("outcome: passed");
    expect(text).toContain("work_type: docs");
    expect(text).toContain("verdict: pass — 満たしている");
    expect(text).toContain("1: implement=completed checks=passed verdict=pass");
    expect(text).toContain(" README.md | 1 +");
    expect(h.closed()).toBe(1);
    const [job] = h.setup.db.select().from(jobs).all();
    expect(job).toMatchObject({ requested_by: "dev", issue_number: 0 });
    // 1行目がタイトルとして計画役に渡る
    expect(JSON.stringify(h.setup.fake.requests[0]?.messages)).toContain("README を直す");
  });

  test("--plan を渡すと計画役を呼ばない", async () => {
    const h = harness(
      [edit(), textResponse("足しました"), { text: JSON.stringify(PASS) }],
      "google-ai-studio",
    );
    const f = files();
    const code = await runPipelineDevCli(
      ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan],
      { GEMINI_API_KEY: TEST_API_KEY },
      h.io,
    );
    expect(code).toBe(EXIT_PASSED);
    expect(h.setup.fake.requests.map((r) => r.model)).not.toContain("plan-model");
    expect(h.out.join("")).toContain("--plan で渡した計画");
  });

  test("不合格 → 1、失敗 → 3", async () => {
    const rejected = harness(
      [edit(), textResponse("x"), { text: JSON.stringify(FAIL) }],
      "google-ai-studio",
    );
    const f = files();
    expect(
      await runPipelineDevCli(
        ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan],
        { GEMINI_API_KEY: TEST_API_KEY },
        rejected.io,
      ),
    ).toBe(EXIT_REJECTED);

    const failed = harness([edit(), textResponse("x")], "google-ai-studio", {
      exec: () => ({ exitCode: 127 }),
    });
    expect(
      await runPipelineDevCli(
        ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan],
        { GEMINI_API_KEY: TEST_API_KEY },
        failed.io,
      ),
    ).toBe(EXIT_FAILED);
    expect(failed.closed()).toBe(1);
  });

  test("--json は outcome・rounds・diff を含み、秘密情報は伏せ字", async () => {
    const token = `ghp_${"d".repeat(36)}`;
    const h = harness(
      [
        toolCallResponse("write_file", { path: "secret.txt", content: `token=${token}\n` }),
        textResponse(`書きました ${token}`),
        { text: JSON.stringify({ ...PASS, reasons: `ok ${token}` }) },
      ],
      "google-ai-studio",
    );
    const f = files(`Issue ${token}\n本文`);
    const code = await runPipelineDevCli(
      ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan, "--json"],
      { GEMINI_API_KEY: TEST_API_KEY },
      h.io,
    );
    expect(code).toBe(EXIT_PASSED);
    const text = h.out.join("");
    const parsed = JSON.parse(text) as { outcome: string; rounds: unknown[]; diff: string };
    expect(parsed.outcome).toBe("passed");
    expect(parsed.rounds).toHaveLength(1);
    expect(parsed.diff).toContain("secret.txt");
    expect(text).not.toContain(token);
    expect(h.err.join("")).not.toContain(token);
  });

  test("APIキーがなければ 2。準備に失敗したら 2", async () => {
    const h = harness([], "google-ai-studio");
    const f = files();
    expect(await runPipelineDevCli(["--repo", f.dir, "--issue", f.issue], {}, h.io)).toBe(
      EXIT_ERROR,
    );
    expect(h.err.join("")).toContain("GEMINI_API_KEY");

    const broken = harness([], "google-ai-studio", { prepareFails: true });
    expect(
      await runPipelineDevCli(
        ["--repo", f.dir, "--issue", f.issue],
        { GEMINI_API_KEY: TEST_API_KEY },
        broken.io,
      ),
    ).toBe(EXIT_ERROR);
    expect(broken.err.join("")).toContain("準備に失敗しました");
  });

  test("中断すると 3 で終わり、片付ける", async () => {
    const controller = new AbortController();
    const h = harness([{ hang: true }], "google-ai-studio", {
      onHang: () => controller.abort(),
    });
    const f = files();
    const code = await runPipelineDevCli(
      ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan],
      { GEMINI_API_KEY: TEST_API_KEY },
      { ...h.io, signal: controller.signal },
    );
    expect(code).toBe(EXIT_FAILED);
    expect(h.out.join("")).toContain("outcome: aborted");
    expect(h.closed()).toBe(1);
  });
});
