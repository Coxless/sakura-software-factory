import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { llmCalls } from "../queue/schema.ts";
import { modelForRole } from "./provider.ts";
import { createGatedStreamFn } from "./stream.ts";
import {
  createFakeLlm,
  createTestGateDeps,
  FAKE_EXHAUSTED_MESSAGE,
  type FakeResponse,
  TEST_NOW,
} from "./testing.ts";

const tool = {
  name: "read_file",
  description: "ファイルを読む",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function gatedCaller(setup: ReturnType<typeof createTestGateDeps>) {
  const model = modelForRole(setup.deps.models, setup.deps.config, "implementer");
  const streamFn = createGatedStreamFn(setup.deps, {
    jobId: null,
    phase: "implement",
    role: "implementer",
  });
  return async (text: string) => {
    const stream = await streamFn(
      model,
      normalizeContext({
        messages: [{ role: "user", content: text, timestamp: TEST_NOW }],
        tools: [tool],
      }),
    );
    return stream.result();
  };
}

describe("createFakeLlm", () => {
  test("テキスト・ツール呼び出し・HTTP エラーを仕込むと、ゲート越しに仕込んだ順に返る（US5-1）", async () => {
    const responses: FakeResponse[] = [
      { text: "はい" },
      { toolCall: { name: "read_file", args: { path: "README.md" } } },
      { httpError: 400 },
    ];
    const setup = createTestGateDeps({ responses });
    const call = gatedCaller(setup);

    const first = await call("1");
    expect(first.content).toEqual([expect.objectContaining({ type: "text", text: "はい" })]);
    const second = await call("2");
    expect(second.stopReason).toBe("toolUse");
    expect(second.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "read_file",
        arguments: { path: "README.md" },
      }),
    ]);
    const third = await call("3");
    expect(third.stopReason).toBe("error");
    expect(third.errorMessage).toMatch(/^400/);
    expect(setup.fake.remaining()).toBe(0);
    setup.close();
  });

  test("仕込みが尽きると、テストの失敗と分かるエラーになる（US5-2）", async () => {
    const fake = createFakeLlm([]);
    await expect(
      fake.fetch("https://sakura.test/v1/chat/completions", { body: "{}" }),
    ).rejects.toThrow(FAKE_EXHAUSTED_MESSAGE);

    const setup = createTestGateDeps({ responses: [], config: { llm: { max_attempts: 1 } } });
    const message = await gatedCaller(setup)("x");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain(FAKE_EXHAUSTED_MESSAGE);
    setup.close();
  });

  test("受け取ったモデル名・メッセージ・ツールの定義をあとから確かめられる（US5-3）", async () => {
    const setup = createTestGateDeps({ responses: [{ text: "ok" }] });
    await gatedCaller(setup)("README を読んで");
    const [request] = setup.fake.requests;
    expect(request?.model).toBe("impl-model");
    expect(JSON.stringify(request?.messages)).toContain("README を読んで");
    expect(request?.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "read_file" }),
      }),
    ]);
    setup.close();
  });

  test("仕込んだ usage が llm_calls に入る（US5-4）", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "ok", usage: { input: 77, output: 8 } }],
    });
    await gatedCaller(setup)("x");
    expect(setup.db.select().from(llmCalls).get()).toMatchObject({
      input_tokens: 77,
      output_tokens: 8,
    });
    setup.close();
  });

  test("createTestGateDeps は予算と LLM の設定を一部だけ上書きできる", () => {
    const setup = createTestGateDeps({
      config: { budget: { per_job_requests: 7 }, llm: { max_attempts: 5 } },
    });
    expect(setup.deps.config.budget).toMatchObject({ monthly_requests: 3000, per_job_requests: 7 });
    expect(setup.deps.config.llm.max_attempts).toBe(5);
    setup.close();
  });
});
