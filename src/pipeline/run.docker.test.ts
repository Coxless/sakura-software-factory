/**
 * 作業場（Docker）を使う、計画から判定までの工程のテスト（005 T030）。Docker とイメージがなければ理由を出して飛ばす。
 * 偽の LLM ＋本物の作業場で、工程内テストのコマンドが作業場の中で走り、失敗が差し込まれ、2回目の完了で通ることを確かめる。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, test } from "vitest";
import type { FactoryConfig } from "../config.ts";
import { createTestGateDeps, TEST_NOW } from "../llm/testing.ts";
import { jobs } from "../queue/schema.ts";
import {
  dockerSkipReason,
  makeWorkspace,
  reportSkip,
  testSandboxConfig,
  testToolsConfig,
} from "../sandbox/testing.ts";
import { runPipelineInSandbox } from "./run.ts";
import { textResponse, toolCallResponse } from "./testing.ts";

const skip = await dockerSkipReason();
reportSkip(skip);

describe.skipIf(skip)("作業場の上で計画から判定までを回す", () => {
  const cleanups: (() => void)[] = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  test("テストの失敗が差し込まれ、2回目の完了で通り、合格。作業場は残らない", async () => {
    const ws = await makeWorkspace({ "src/a.ts": "export const a = 1;\n" });
    cleanups.push(ws.cleanup);
    const traceDir = mkdtempSync(join(tmpdir(), "pipeline-docker-"));
    cleanups.push(() => rmSync(traceDir, { recursive: true, force: true }));
    const gate = createTestGateDeps({
      responses: [
        textResponse("終わりました"),
        toolCallResponse("write_file", { path: "done.txt", content: "ok\n" }),
        textResponse("done.txt を作りました"),
        {
          text: JSON.stringify({ verdict: "pass", reasons: "done.txt がある", criteria: [] }),
        },
      ],
      config: {
        storage: { trace_dir: traceDir },
        pipeline: { check_commands: ["test -f done.txt"] },
      },
    });
    cleanups.push(gate.close);
    const config = {
      ...gate.deps.config,
      sandbox: testSandboxConfig(),
      tools: testToolsConfig(),
    } as FactoryConfig;
    const [job] = gate.db
      .insert(jobs)
      .values({
        repo: "local:demo",
        issue_number: 0,
        trigger_comment_id: 1,
        requested_by: "dev",
        instruction: "@agent",
        created_at: 1,
        updated_at: 1,
      })
      .returning()
      .all();
    const jobId = 950_000 + (process.pid % 1000) * 10 + (job?.id as number);
    gate.db.update(jobs).set({ id: jobId }).run();

    const result = await runPipelineInSandbox(
      { gate: { ...gate.deps, config }, now: () => TEST_NOW },
      {
        jobId,
        workdir: ws.path,
        issue: { title: "done.txt を作る", body: "done.txt を作ってください" },
        plan: "done.txt を作る",
        deadline: TEST_NOW + 10 * 60_000,
      },
    );

    expect(result.outcome).toBe("passed");
    expect(result.diff).toContain("done.txt");
    expect(result.rounds[0]?.checks).toEqual({ status: "passed", runs: 2, fedBack: 1 });
    const containers = await execa("docker", [
      "ps",
      "-a",
      "--filter",
      `name=factory-job-${jobId}`,
      "--format",
      "{{.Names}}",
    ]);
    expect(containers.stdout.trim()).toBe("");
  }, 120_000);
});
