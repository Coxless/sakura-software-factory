import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryConfig } from "./config.ts";
import {
  EXIT_COMPLETED,
  EXIT_ERROR,
  EXIT_NOT_COMPLETED,
  exitCodeOf,
  parseImplementDevArgs,
  runImplementDevCli,
  UsageError,
} from "./implement-dev.ts";
import { createLlmModels } from "./llm/provider.ts";
import { createTestGateDeps, type FakeResponse, TEST_API_KEY, TEST_NOW } from "./llm/testing.ts";
import { createFakeWorkspace, textResponse, toolCallResponse } from "./pipeline/testing.ts";
import { jobs } from "./queue/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files() {
  const dir = mkdtempSync(join(tmpdir(), "implement-dev-"));
  dirs.push(dir);
  writeFileSync(join(dir, "issue.md"), "README に1行足す");
  writeFileSync(join(dir, "plan.md"), "1. README.md を読む");
  return { dir, issue: join(dir, "issue.md"), plan: join(dir, "plan.md") };
}

describe("parseImplementDevArgs", () => {
  test("必須の引数と任意の引数を読む", () => {
    expect(
      parseImplementDevArgs([
        "--",
        "--repo",
        "/r",
        "--issue",
        "i.md",
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
      plan: "p.md",
      install: "pnpm install --frozen-lockfile",
      maxTurns: 5,
      timeoutMinutes: 10,
      allowSakura: true,
      json: true,
    });
  });

  test("必須の引数がない・未知の引数・数の誤りはエラー", () => {
    expect(() => parseImplementDevArgs(["--repo", "/r", "--issue", "i"])).toThrow(/--plan/);
    expect(() =>
      parseImplementDevArgs(["--repo", "/r", "--issue", "i", "--plan", "p", "--x"]),
    ).toThrow(UsageError);
    expect(() =>
      parseImplementDevArgs(["--repo", "/r", "--issue", "i", "--plan", "p", "--max-turns", "0"]),
    ).toThrow(/--max-turns/);
  });
});

describe("exitCodeOf", () => {
  test("completed なら 0、ほかは 1", () => {
    expect(exitCodeOf({ outcome: "completed" })).toBe(EXIT_COMPLETED);
    expect(exitCodeOf({ outcome: "max_turns" })).toBe(EXIT_NOT_COMPLETED);
    expect(exitCodeOf({ outcome: "failed" })).toBe(EXIT_NOT_COMPLETED);
  });
});

function harness(responses: FakeResponse[], provider: "sakura" | "google-ai-studio") {
  const traceDir = mkdtempSync(join(tmpdir(), "implement-dev-trace-"));
  dirs.push(traceDir);
  const setup = createTestGateDeps({ responses, config: { storage: { trace_dir: traceDir } } });
  const config = {
    ...setup.deps.config,
    llm: { ...setup.deps.config.llm, provider },
  } as FactoryConfig;
  const deps = { ...setup.deps, config, models: createLlmModels(config) };
  const workspace = createFakeWorkspace({ "README.md": "# demo\n" }, { config });
  const out: string[] = [];
  const err: string[] = [];
  let prepared = false;
  const io = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    loadConfig: () => config,
    createDeps: () => ({ deps, close: () => {} }),
    prepare: async () => {
      prepared = true;
      return {
        workspace,
        dir: "/tmp/fake/repo",
        diffStat: async () => " README.md | 1 +",
        close: async () => {},
      };
    },
    now: () => TEST_NOW,
  };
  return { setup, io, out, err, workspace, prepared: () => prepared };
}

describe("runImplementDevCli", () => {
  test("さくらの設定では --allow-sakura がなければ 2 で止まり、何も用意しない", async () => {
    const h = harness([textResponse("done")], "sakura");
    const f = files();
    const code = await runImplementDevCli(
      ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan],
      { SAKURA_AI_API_KEY: TEST_API_KEY },
      h.io,
    );
    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("")).toContain("--allow-sakura");
    expect(h.prepared()).toBe(false);
    expect(h.setup.fake.requests).toHaveLength(0);
  });

  test("開発用の設定なら実行し、結果・軌跡・diff を表示して 0", async () => {
    const h = harness(
      [
        toolCallResponse("edit_file", {
          path: "README.md",
          old_string: "# demo",
          new_string: "# demo\nimplement:dev で試せる",
        }),
        textResponse("README に1行足しました"),
      ],
      "google-ai-studio",
    );
    const f = files();
    const code = await runImplementDevCli(
      ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan],
      { GEMINI_API_KEY: TEST_API_KEY },
      h.io,
    );
    expect(h.err.join("")).toBe("");
    expect(h.out.join("")).toContain("outcome: completed");
    expect(code).toBe(EXIT_COMPLETED);
    const text = h.out.join("");
    expect(text).toContain("provider: google-ai-studio");
    expect(text).toContain("outcome: completed");
    expect(text).toContain("README に1行足しました");
    expect(text).toContain(" README.md | 1 +");
    expect(h.workspace.files.get("README.md")).toContain("implement:dev で試せる");
    const [job] = h.setup.db.select().from(jobs).all();
    expect(job).toMatchObject({ requested_by: "dev", issue_number: 0, status: "implementing" });
  });

  test("APIキーがなければ 2", async () => {
    const h = harness([], "google-ai-studio");
    const f = files();
    const code = await runImplementDevCli(
      ["--repo", f.dir, "--issue", f.issue, "--plan", f.plan],
      {},
      h.io,
    );
    expect(code).toBe(EXIT_ERROR);
    expect(h.err.join("")).toContain("GEMINI_API_KEY");
  });
});
