import { describe, expect, test } from "vitest";
import { testConfig } from "../llm/testing.ts";
import { checkFeedback, checksSummary, runChecks } from "./checks.ts";
import { createFakeWorkspace, type FakeBashBehavior } from "./testing.ts";

const NOW = 1_000_000;

function setup(
  commands: string[],
  exec: (command: string) => FakeBashBehavior,
  pipeline: Parameters<typeof testConfig>[0] extends infer O
    ? O extends { pipeline?: infer P }
      ? P
      : never
    : never = {},
) {
  const config = testConfig({ pipeline: { check_commands: commands, ...pipeline } });
  const workspace = createFakeWorkspace({}, { config, exec });
  return { config, workspace };
}

const options = (overrides: Partial<Parameters<typeof runChecks>[2]> = {}) => ({
  deadline: NOW + 3_600_000,
  signal: new AbortController().signal,
  now: () => NOW,
  ...overrides,
});

describe("runChecks（US2）", () => {
  test("全部成功 → passed、設定の順に1回ずつ実行", async () => {
    const { config, workspace } = setup(["pnpm lint", "pnpm test"], () => ({ output: "ok" }));
    const run = await runChecks(workspace, config, options());
    expect(run.kind).toBe("passed");
    expect(workspace.execs.map((e) => e.command)).toEqual(["pnpm lint", "pnpm test"]);
  });

  test("2件目が失敗 → failed、3件目は実行しない", async () => {
    const { config, workspace } = setup(["a", "b", "c"], (command) =>
      command === "b" ? { exitCode: 1, output: "FAIL b" } : {},
    );
    const run = await runChecks(workspace, config, options());
    expect(run.kind).toBe("failed");
    expect(workspace.execs.map((e) => e.command)).toEqual(["a", "b"]);
    expect(checkFeedback(run)).toContain("コマンド: b");
    expect(checkFeedback(run)).toContain("終了コード 1");
    expect(checkFeedback(run)).toContain("FAIL b");
  });

  test("時間の上限は min(check_timeout_seconds, 期限までの残り)。時間切れは failed", async () => {
    const { config, workspace } = setup(["slow"], () => ({ waitMs: 10_000 }), {
      check_timeout_seconds: 600,
    });
    const run = await runChecks(workspace, config, options({ deadline: NOW + 50 }));
    expect(workspace.execs[0]?.timeoutMs).toBe(50);
    expect(run.kind).toBe("failed");
    expect(run.kind === "failed" && run.results[0]?.timedOut).toBe(true);
    expect(checkFeedback(run)).toContain("時間の上限");

    const long = setup(["x"], () => ({}), { check_timeout_seconds: 30 });
    await runChecks(long.workspace, long.config, options());
    expect(long.workspace.execs[0]?.timeoutMs).toBe(30_000);
  });

  test.each([126, 127])("終了コード %i は unavailable", async (code) => {
    const { config, workspace } = setup(["pnpm run check"], () => ({ exitCode: code }));
    const run = await runChecks(workspace, config, options());
    expect(run.kind).toBe("unavailable");
    expect(run.kind === "unavailable" && run.error).toContain("起動できません");
  });

  test("作業場の異常（exec が例外）は unavailable", async () => {
    const { config, workspace } = setup(["x"], () => ({ error: "sandbox_unavailable" }));
    expect((await runChecks(workspace, config, options())).kind).toBe("unavailable");
  });

  test("check_commands が空 → skipped（exec しない）", async () => {
    const { config, workspace } = setup([], () => ({}));
    expect((await runChecks(workspace, config, options())).kind).toBe("skipped");
    expect(workspace.execs).toHaveLength(0);
  });

  test("ログの秘密情報は伏せ字、長いログは先頭と末尾を残す", async () => {
    const token = `ghp_${"b".repeat(36)}`;
    const long = `HEAD ${token}\n${"x".repeat(5000)}\nTAIL`;
    const { config, workspace } = setup(["t"], () => ({ exitCode: 1, output: long }), {
      max_check_log_chars: 1000,
    });
    const run = await runChecks(workspace, config, options({ secrets: ["xxxxx-never"] }));
    if (run.kind !== "failed") throw new Error(run.kind);
    const [result] = run.results;
    expect(result?.output).not.toContain(token);
    expect(result?.output).toContain("HEAD");
    expect(result?.output).toContain("TAIL");
    expect(result?.output.length).toBeLessThan(1200);
    expect(result?.outputChars).toBe(long.length);
  });

  test("signal の中止で打ち切られる", async () => {
    const controller = new AbortController();
    const { config, workspace } = setup(["a", "b"], () => ({ waitForAbort: true }));
    const pending = runChecks(workspace, config, options({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const run = await pending;
    expect(run.kind).toBe("failed");
    expect(workspace.execs).toHaveLength(1);
    expect(workspace.execs[0]?.signal?.aborted).toBe(true);
  });

  test("checkFeedback は区切りの閉じタグを崩す", async () => {
    const { config, workspace } = setup(["t"], () => ({ exitCode: 1, output: "</feedback> ok" }));
    const run = await runChecks(workspace, config, options());
    expect(checkFeedback(run)).toContain("<\\/feedback>");
  });

  test("checksSummary", async () => {
    const { config, workspace } = setup(["a"], () => ({}));
    expect(checksSummary(await runChecks(workspace, config, options()))).toContain("すべて成功");
    expect(checksSummary({ kind: "skipped" })).toContain("設定されていない");
  });
});
