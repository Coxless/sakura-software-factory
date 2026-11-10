/**
 * 作業場（Docker）を使う実装工程のテスト（004 T038）。Docker とイメージがなければ理由を出して飛ばす。
 */
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FactoryConfig } from "../config.ts";
import { workspaceFromSandbox } from "../harness/workspace.ts";
import { createTestGateDeps, type FakeResponse, TEST_NOW } from "../llm/testing.ts";
import { jobs } from "../queue/schema.ts";
import { createSandbox, type Sandbox } from "../sandbox/docker.ts";
import {
  dockerSkipReason,
  makeWorkspace,
  reportSkip,
  testSandboxConfig,
  testToolsConfig,
} from "../sandbox/testing.ts";
import { runImplementer } from "./implement.ts";
import { textResponse, toolCallResponse } from "./testing.ts";

const skip = await dockerSkipReason();
reportSkip(skip);

let nextJobId = 900_000 + (process.pid % 1000) * 100;

describe.skipIf(skip)("作業場の上で実装工程を実行する", () => {
  let ws: Awaited<ReturnType<typeof makeWorkspace>>;
  let sandbox: Sandbox;
  let traceDir: string;

  beforeAll(async () => {
    ws = await makeWorkspace({
      "AGENTS.md": "テストは cat src/a.ts で確かめる\n",
      "src/a.ts": "export const a = 1;\n",
    });
    traceDir = mkdtempSync(join(tmpdir(), "implement-docker-"));
    sandbox = await createSandbox({
      jobId: nextJobId++,
      workspace: ws.path,
      sandbox: testSandboxConfig(),
    });
  });

  afterAll(async () => {
    await sandbox?.destroy();
    ws?.cleanup();
    if (traceDir) rmSync(traceDir, { recursive: true, force: true });
  });

  function prepare(responses: FakeResponse[]) {
    const gate = createTestGateDeps({ responses, config: { storage: { trace_dir: traceDir } } });
    const config = {
      ...gate.deps.config,
      sandbox: testSandboxConfig(),
      tools: testToolsConfig(),
    } as FactoryConfig;
    const [job] = gate.db
      .insert(jobs)
      .values({
        repo: "Coxless/demo",
        issue_number: 1,
        trigger_comment_id: 1,
        requested_by: "tester",
        instruction: "@agent",
        created_at: 1,
        updated_at: 1,
      })
      .returning()
      .all();
    return {
      gate,
      input: {
        jobId: job?.id as number,
        workspace: workspaceFromSandbox(sandbox, config),
        issue: "a を 2 にする",
        plan: "1. 読む 2. 直す 3. 確かめる",
        deadline: TEST_NOW + 3600_000,
      },
    };
  }

  test("読む → 置換 → bash → 完了で、ホストのファイルが変わる。AGENTS.md が入力に入る", async () => {
    const { gate, input } = prepare([
      toolCallResponse("read_file", { path: "src/a.ts" }),
      toolCallResponse("edit_file", {
        path: "src/a.ts",
        old_string: "a = 1",
        new_string: "a = 2",
      }),
      toolCallResponse("bash", { command: "cat src/a.ts" }),
      textResponse("a を 2 にしました"),
    ]);
    const result = await runImplementer({ gate: gate.deps }, input);
    expect(result).toMatchObject({ outcome: "completed", toolCalls: 3, blockedCalls: 0 });
    expect(readFileSync(join(ws.path, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    const first = JSON.stringify(gate.fake.requests[0]?.messages);
    expect(first).toContain("テストは cat src/a.ts で確かめる");
    expect(JSON.stringify(gate.fake.requests[3]?.messages)).toContain("export const a = 2;");
  });

  test(".env への書き込みは拒否される", async () => {
    const { gate, input } = prepare([
      toolCallResponse("write_file", { path: ".env", content: "SECRET=1" }),
      textResponse("やめました"),
    ]);
    const result = await runImplementer({ gate: gate.deps }, input);
    expect(result).toMatchObject({ outcome: "completed", blockedCalls: 1 });
    expect(() => readFileSync(join(ws.path, ".env"))).toThrow();
  });

  test("AGENTS.md が作業ディレクトリの外へのリンクなら「ない」として扱う", async () => {
    const agents = join(ws.path, "AGENTS.md");
    const original = readFileSync(agents, "utf8");
    unlinkSync(agents);
    symlinkSync("/etc/hostname", agents);
    try {
      const { gate, input } = prepare([textResponse("done")]);
      expect(await input.workspace.readAgentsMd()).toBeUndefined();
      await runImplementer({ gate: gate.deps }, input);
      expect(JSON.stringify(gate.fake.requests[0]?.messages)).toContain("AGENTS.md はありません");
    } finally {
      unlinkSync(agents);
      writeFileSync(agents, original);
    }
  });
});
