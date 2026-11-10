import { asc } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { llmCalls } from "../queue/schema.ts";
import { runSmoke, type SmokeMode, type SmokeReport } from "./smoke.ts";
import { createTestGateDeps, type FakeResponse, TEST_API_KEY } from "./testing.ts";

const PONG: FakeResponse = { text: "pong", usage: { input: 30, output: 1 } };
const TOOL_CALL: FakeResponse = {
  toolCall: { name: "get_weather", args: { city: "東京" } },
  usage: { input: 80, output: 12 },
};
const AFTER_TOOL: FakeResponse = { text: "東京は晴れです", usage: { input: 120, output: 6 } };

const passedOf = (report: SmokeReport) =>
  Object.fromEntries(report.checks.map((check) => [check.id, check.passed]));

async function smoke(mode: SmokeMode, responses: FakeResponse[]) {
  const setup = createTestGateDeps({ responses });
  const report = await runSmoke(setup.deps, { role: "implementer", mode });
  const rows = setup.db.select().from(llmCalls).orderBy(asc(llmCalls.id)).all();
  return { setup, report, rows };
}

describe.each<SmokeMode>(["pi", "raw", "raw-nostream"])("runSmoke（%s）", (mode) => {
  test("正しいツール呼び出しなら6項目すべて合格・3リクエスト・llm_calls に3行", async () => {
    const { setup, report, rows } = await smoke(mode, [PONG, TOOL_CALL, AFTER_TOOL]);
    expect(report).toMatchObject({ model: "impl-model", mode, requests: 3, passed: true });
    expect(passedOf(report)).toEqual({ a: true, b: true, c: true, d: true, e: true, f: true });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ phase: "smoke", job_id: null, role: "implementer" });
    }
    // 3つ目の要求に、ツール呼び出しとその結果が入っている
    expect(JSON.stringify(setup.fake.requests[2]?.messages)).toContain("晴れ");
    setup.close();
  });

  test("ツール呼び出しの extra_content（Gemini の thought_signature）を、次の要求でそのまま送り返す", async () => {
    const signed: FakeResponse = {
      toolCall: { name: "get_weather", args: { city: "東京" } },
      extraContent: { google: { thought_signature: "sig-123" } },
      usage: { input: 80, output: 12 },
    };
    const { setup, report } = await smoke(mode, [PONG, signed, AFTER_TOOL]);
    expect(report.passed).toBe(true);
    const assistant = (
      (setup.fake.requests[2]?.messages ?? []) as { role: string; tool_calls?: unknown[] }[]
    ).find((message) => message.role === "assistant");
    expect(assistant?.tool_calls).toEqual([
      expect.objectContaining({
        id: "call_fake_1",
        extra_content: { google: { thought_signature: "sig-123" } },
      }),
    ]);
    setup.close();
  });

  test("ツール呼び出しが本文に XML として漏れると (b) と (e) が不合格で、detail にマスク済みの本文", async () => {
    const leaked: FakeResponse = {
      text: `<tool_call>{"name":"get_weather","arguments":{"city":"東京"}}</tool_call> key=${TEST_API_KEY}`,
      usage: { input: 80, output: 30 },
    };
    const { setup, report } = await smoke(mode, [PONG, leaked]);
    const checks = passedOf(report);
    expect(checks.b).toBe(false);
    expect(checks.e).toBe(false);
    expect(checks.d).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.requests).toBe(2);
    const detail = report.checks.find((check) => check.id === "e")?.detail ?? "";
    expect(detail).toContain("<tool_call>");
    expect(detail).not.toContain(TEST_API_KEY);
    setup.close();
  });

  test("引数がツールの定義に合わないと (c) が不合格", async () => {
    const wrongArgs: FakeResponse = {
      toolCall: { name: "get_weather", args: { location: "Tokyo" } },
      usage: { input: 80, output: 12 },
    };
    const { setup, report } = await smoke(mode, [PONG, wrongArgs, AFTER_TOOL]);
    expect(passedOf(report)).toMatchObject({ b: true, c: false });
    expect(report.checks.find((check) => check.id === "c")?.detail).toContain("location");
    setup.close();
  });

  test("usage が返らないと (f) が不合格", async () => {
    const { setup, report } = await smoke(mode, [
      { text: "pong" },
      { toolCall: { name: "get_weather", args: { city: "東京" } } },
      { text: "晴れです" },
    ]);
    expect(passedOf(report)).toMatchObject({ a: true, b: true, d: true, f: false });
    setup.close();
  });
});

describe("runSmoke の要求の形", () => {
  test("raw はストリーミング（include_usage 付き）、raw-nostream は stream: false で送る", async () => {
    const raw = await smoke("raw", [PONG, TOOL_CALL, AFTER_TOOL]);
    expect(raw.setup.fake.requests[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(raw.setup.fake.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(raw.setup.fake.requests[1]?.body.tool_choice).toBeUndefined();
    raw.setup.close();

    const nostream = await smoke("raw-nostream", [PONG, TOOL_CALL, AFTER_TOOL]);
    expect(nostream.setup.fake.requests[0]?.body.stream).toBe(false);
    nostream.setup.close();
  });

  test("一時的な失敗は再試行し、送った件数を requests に数える", async () => {
    const { setup, report, rows } = await smoke("raw", [
      { httpError: 503 },
      PONG,
      TOOL_CALL,
      AFTER_TOOL,
    ]);
    expect(report.passed).toBe(true);
    expect(report.requests).toBe(4);
    expect(rows).toHaveLength(4);
    setup.close();
  });

  test("恒久的なエラーは例外にし、それまでの requests を持たせる", async () => {
    const setup = createTestGateDeps({ responses: [{ httpError: 401 }] });
    await expect(runSmoke(setup.deps, { role: "implementer", mode: "pi" })).rejects.toMatchObject({
      name: "SmokeError",
      requests: 1,
    });
    setup.close();
  });

  test("pi で互換フラグを上書きすると、要求とレポートに反映される", async () => {
    const setup = createTestGateDeps({ responses: [{ text: "pong" }, TOOL_CALL, AFTER_TOOL] });
    const report = await runSmoke(setup.deps, {
      role: "implementer",
      mode: "pi",
      compat: { supportsUsageInStreaming: false },
    });
    expect(report.compat).toMatchObject({ supportsUsageInStreaming: false });
    expect(setup.fake.requests[0]?.body.stream_options).toBeUndefined();
    setup.close();
  });
});
