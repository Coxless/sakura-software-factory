import { Agent, type AgentOptions } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { asc } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { jobs, llmCalls } from "../queue/schema.ts";
import { BudgetExceededError } from "./budget.ts";
import { modelForRole } from "./provider.ts";
import {
  type CallContext,
  createGatedStreamFn,
  GUARD_MESSAGE,
  getBudgetExceeded,
  installStreamFnGuard,
  runGated,
} from "./stream.ts";
import { createTestGateDeps, type FakeResponse, TEST_API_KEY, TEST_NOW } from "./testing.ts";

const ctx: CallContext = { jobId: null, phase: "implement", role: "implementer" };
const context = (text = "こんにちは"): Context => ({
  systemPrompt: "あなたはテスト用のアシスタントです",
  messages: [{ role: "user", content: text, timestamp: TEST_NOW }],
});

/** ゲート越しに1回呼び、流れたイベントと最終メッセージを返す */
async function callGated(
  setup: ReturnType<typeof createTestGateDeps>,
  callContext: CallContext = ctx,
  options: { signal?: AbortSignal } = {},
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const { deps } = setup;
  const model = modelForRole(deps.models, deps.config, callContext.role);
  const streamFn = createGatedStreamFn(deps, callContext);
  const stream = await streamFn(model, normalizeContext(context()), options);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

const rows = (setup: ReturnType<typeof createTestGateDeps>) =>
  setup.db.select().from(llmCalls).orderBy(asc(llmCalls.id)).all();

describe("runGated（中核）", () => {
  test("予算の確認 → 試行 → llm_calls に1件を書き、値を返す", async () => {
    const setup = createTestGateDeps();
    const value = await runGated(setup.deps, ctx, "impl-model", async () => ({
      ok: true,
      usage: { input: 12, output: 3 },
      value: "結果",
    }));
    expect(value).toBe("結果");
    expect(rows(setup)).toEqual([
      {
        id: 1,
        job_id: null,
        phase: "implement",
        role: "implementer",
        model: "impl-model",
        attempt: 1,
        input_tokens: 12,
        output_tokens: 3,
        latency_ms: expect.any(Number),
        status: "ok",
        error_kind: null,
        error: null,
        created_at: TEST_NOW,
      },
    ]);
    expect(rows(setup)[0]?.latency_ms).toBeGreaterThanOrEqual(0);
    setup.close();
  });

  test("予算切れなら試行せず、記録もせずに BudgetExceededError を投げる", async () => {
    const setup = createTestGateDeps({ config: { budget: { monthly_requests: 1 } } });
    await runGated(setup.deps, ctx, "impl-model", async () => ({ ok: true, value: 1 }));
    let attempted = false;
    await expect(
      runGated(setup.deps, ctx, "impl-model", async () => {
        attempted = true;
        return { ok: true, value: 2 };
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(attempted).toBe(false);
    expect(rows(setup)).toHaveLength(1);
    setup.close();
  });
});

describe("createGatedStreamFn（中核）", () => {
  test("偽の LLM のテキスト応答が AssistantMessage で返り、start から done の順に流れる", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "pong", usage: { input: 20, output: 2 } }],
    });
    const { events, message } = await callGated(setup);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "pong" })]);
    expect(message.usage).toMatchObject({ input: 20, output: 2 });
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("done");
    expect(rows(setup)).toMatchObject([
      { attempt: 1, status: "ok", input_tokens: 20, output_tokens: 2, model: "impl-model" },
    ]);
    setup.close();
  });

  test("内側にはゲートの fetch と APIキーが渡り、Pi の内部リトライは起きない", async () => {
    // Pi が内部で再試行すれば 2件目の仕込みが使われる
    const responses: FakeResponse[] = [{ httpError: 500 }, { text: "二回目" }];
    const setup = createTestGateDeps({ responses, config: { llm: { max_attempts: 1 } } });
    const { message } = await callGated(setup);
    expect(message.stopReason).toBe("error");
    expect(setup.fake.requests).toHaveLength(1);
    expect(setup.fake.remaining()).toBe(1);
    expect(setup.fake.requests[0]?.url).toBe("https://sakura.test/v1/chat/completions");
    expect(setup.fake.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(setup.fake.requests[0]?.body.stream).toBe(true);
    setup.close();
  });

  test("予算切れは LLM に送らず error イベントで返し、getBudgetExceeded で取り出せる", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "a" }, { text: "b" }],
      config: { budget: { monthly_requests: 1 } },
    });
    await callGated(setup);
    const { events, message } = await callGated(setup);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(message.stopReason).toBe("error");
    expect(getBudgetExceeded(message)).toMatchObject({ scope: "monthly", limit: 1, used: 1 });
    expect(setup.fake.requests).toHaveLength(1);
    setup.close();
  });
});

describe("installStreamFnGuard", () => {
  test("streamFn を渡さずに作った Agent は、LLM を呼ぶ時点でゲートを通すよう求める例外になる", () => {
    installStreamFnGuard();
    // 型の上では streamFn は必須。渡し忘れた古い呼び出し元を再現する
    const agent = new Agent({} as AgentOptions);
    const setup = createTestGateDeps();
    const model = modelForRole(setup.deps.models, setup.deps.config, "implementer");
    expect(() => agent.streamFunction(model, normalizeContext(context()))).toThrow(GUARD_MESSAGE);
    setup.close();
  });
});

describe("予算の上限（US2）", () => {
  test("月の上限 −1 件まで消費した状態で1回通り、次は LLM に送らず予算切れ（SC-002）", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "a" }, { text: "b" }],
      config: { budget: { monthly_requests: 3, per_job_requests: 3 } },
    });
    for (let i = 0; i < 2; i++) {
      setup.db
        .insert(llmCalls)
        .values({
          phase: "p",
          role: "planner",
          model: "m",
          attempt: 1,
          latency_ms: 1,
          status: "ok",
          created_at: TEST_NOW,
        })
        .run();
    }
    expect((await callGated(setup)).message.stopReason).toBe("stop");
    const { message } = await callGated(setup);
    expect(getBudgetExceeded(message)).toMatchObject({ scope: "monthly", limit: 3, used: 3 });
    expect(setup.fake.requests).toHaveLength(1);
    expect(setup.fake.remaining()).toBe(1);
    setup.close();
  });

  test("ジョブ A が上限に達してもジョブ B は通る（US2-3）", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "a" }, { text: "b" }],
      config: { budget: { monthly_requests: 100, per_job_requests: 1 } },
    });
    const newJob = (commentId: number) =>
      setup.db
        .insert(jobs)
        .values({
          repo: "r",
          issue_number: 1,
          trigger_comment_id: commentId,
          requested_by: "u",
          instruction: "i",
          created_at: 1,
          updated_at: 1,
        })
        .returning({ id: jobs.id })
        .get().id;
    const jobA = { ...ctx, jobId: newJob(1) };
    const jobB = { ...ctx, jobId: newJob(2) };
    expect((await callGated(setup, jobA)).message.stopReason).toBe("stop");
    const blocked = await callGated(setup, jobA);
    expect(getBudgetExceeded(blocked.message)).toMatchObject({ scope: "job", limit: 1, used: 1 });
    expect((await callGated(setup, jobB)).message.stopReason).toBe("stop");
    expect(setup.fake.requests).toHaveLength(2);
    setup.close();
  });

  test("ジョブに属さない呼び出しはジョブの上限を見ない（US2-4）", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "a" }, { text: "b" }, { text: "c" }],
      config: { budget: { monthly_requests: 100, per_job_requests: 1 } },
    });
    for (let i = 0; i < 3; i++) expect((await callGated(setup)).message.stopReason).toBe("stop");
    setup.close();
  });
});

describe("再試行（US3）", () => {
  test("429 → 成功なら、呼び出し元には成功が返り、記録は2件（SC-004）", async () => {
    const setup = createTestGateDeps({ responses: [{ httpError: 429 }, { text: "ok" }] });
    const { message } = await callGated(setup);
    expect(message.stopReason).toBe("stop");
    expect(rows(setup)).toMatchObject([
      {
        attempt: 1,
        status: "error",
        error_kind: "transient",
        error: expect.stringMatching(/^429/),
      },
      { attempt: 2, status: "ok", error_kind: null, error: null },
    ]);
    setup.close();
  });

  test("500 が続くと max_attempts 回で失敗し、同じ件数を記録する（US3-2）", async () => {
    const setup = createTestGateDeps({
      responses: [{ httpError: 500 }, { httpError: 502 }, { httpError: 503 }, { text: "x" }],
    });
    const { events, message } = await callGated(setup);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/^503/);
    expect(rows(setup).map((row) => [row.attempt, row.error_kind])).toEqual([
      [1, "transient"],
      [2, "transient"],
      [3, "transient"],
    ]);
    expect(setup.fake.remaining()).toBe(1);
    expect(setup.sleeps).toHaveLength(2);
    setup.close();
  });

  test.each([401, 403, 404, 422])("%i は再試行せず permanent で1件（US3-3）", async (status) => {
    const setup = createTestGateDeps({ responses: [{ httpError: status }, { text: "x" }] });
    const { message } = await callGated(setup);
    expect(message.stopReason).toBe("error");
    expect(rows(setup)).toMatchObject([{ attempt: 1, status: "error", error_kind: "permanent" }]);
    expect(setup.sleeps).toEqual([]);
    setup.close();
  });

  test("再試行の前に予算が尽きたら送らずに予算切れ（US3-4）", async () => {
    const setup = createTestGateDeps({
      responses: [{ httpError: 500 }, { text: "x" }],
      config: { budget: { monthly_requests: 1 } },
    });
    const { message } = await callGated(setup);
    expect(getBudgetExceeded(message)).toMatchObject({ scope: "monthly", limit: 1, used: 1 });
    expect(setup.fake.requests).toHaveLength(1);
    expect(rows(setup)).toHaveLength(1);
    setup.close();
  });

  test("途中で切れた応答は外側に一切流さず、再試行して成功した応答だけを流す（US3-5）", async () => {
    const setup = createTestGateDeps({
      responses: [{ midStreamError: "terminated" }, { text: "完全な応答" }],
    });
    const { events, message } = await callGated(setup);
    expect(JSON.stringify(events)).not.toContain("途中まで");
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(message.content).toEqual([expect.objectContaining({ text: "完全な応答" })]);
    expect(rows(setup).map((row) => row.error_kind)).toEqual(["transient", null]);
    setup.close();
  });

  test("200 のあとの通信以外のエラーは permanent で再試行しない", async () => {
    const setup = createTestGateDeps({
      responses: [{ midStreamError: "unexpected token in tool arguments" }, { text: "x" }],
    });
    await callGated(setup);
    expect(rows(setup).map((row) => row.error_kind)).toEqual(["permanent"]);
    setup.close();
  });

  test("呼び出し元の取り消しは再試行せず aborted を1件記録する（US3-6）", async () => {
    const controller = new AbortController();
    const setup = createTestGateDeps({
      responses: [{ hang: true }, { text: "x" }],
      onHang: () => controller.abort(),
    });
    const { events, message } = await callGated(setup, ctx, { signal: controller.signal });
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(message.stopReason).toBe("aborted");
    expect(rows(setup)).toMatchObject([{ attempt: 1, status: "error", error_kind: "aborted" }]);
    expect(setup.fake.remaining()).toBe(1);
    setup.close();
  });

  test("retry-after の指示以上待ってから再試行する（US3-7）", async () => {
    const setup = createTestGateDeps({
      responses: [{ httpError: 429, retryAfterSeconds: 2 }, { text: "x" }],
    });
    expect((await callGated(setup)).message.stopReason).toBe("stop");
    expect(setup.sleeps).toEqual([2000]);
    setup.close();
  });

  test("retry-after が max_retry_delay_seconds を超えたら再試行せず permanent（US3-7）", async () => {
    const setup = createTestGateDeps({
      responses: [{ httpError: 429, retryAfterSeconds: 120 }, { text: "x" }],
    });
    const { message } = await callGated(setup);
    expect(message.stopReason).toBe("error");
    expect(rows(setup)).toMatchObject([
      { error_kind: "permanent", error: expect.stringMatching(/^429/) },
    ]);
    expect(setup.sleeps).toEqual([]);
    setup.close();
  });

  test("接続失敗は transient で再試行し、原因をエラーに残す", async () => {
    const setup = createTestGateDeps({
      responses: [{ networkError: "getaddrinfo ENOTFOUND sakura.test" }, { text: "x" }],
    });
    expect((await callGated(setup)).message.stopReason).toBe("stop");
    expect(rows(setup)[0]).toMatchObject({
      error_kind: "transient",
      error: expect.stringContaining("ENOTFOUND"),
    });
    setup.close();
  });

  test("時間の上限を超えたら timeout として再試行する（本物のタイマーは使わない）", async () => {
    const setup = createTestGateDeps({ responses: [{ hang: true }, { text: "x" }] });
    const { message } = await callGated(setup);
    expect(message.stopReason).toBe("stop");
    expect(rows(setup).map((row) => row.error_kind)).toEqual(["timeout", null]);
    setup.close();
  });

  test("x-should-retry: false なら 500 でも再試行しない", async () => {
    const setup = createTestGateDeps({
      responses: [{ httpError: 500, headers: { "x-should-retry": "false" } }, { text: "x" }],
    });
    await callGated(setup);
    expect(rows(setup).map((row) => row.error_kind)).toEqual(["permanent"]);
    setup.close();
  });

  test("記録の件数と、LLM に届いた要求の件数が一致する（SC-003）", async () => {
    const setup = createTestGateDeps({
      responses: [
        { httpError: 429 },
        { networkError: "ECONNRESET" },
        { text: "a" },
        { httpError: 500 },
        { text: "b" },
      ],
    });
    await callGated(setup);
    await callGated(setup);
    expect(rows(setup)).toHaveLength(5);
    expect(setup.fake.requests).toHaveLength(5);
    setup.close();
  });
});

describe("記録とマスク（US4）", () => {
  test("成功時に usage・モデル名・工程・役割・ジョブが入る（US4-1・US4-4）", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "計画です", usage: { input: 321, output: 45 } }],
    });
    const jobId = setup.db
      .insert(jobs)
      .values({
        repo: "r",
        issue_number: 1,
        trigger_comment_id: 1,
        requested_by: "u",
        instruction: "i",
        created_at: 1,
        updated_at: 1,
      })
      .returning({ id: jobs.id })
      .get().id;
    await callGated(setup, { jobId, phase: "plan", role: "planner" });
    expect(rows(setup)).toMatchObject([
      {
        job_id: jobId,
        phase: "plan",
        role: "planner",
        model: "plan-model",
        input_tokens: 321,
        output_tokens: 45,
        status: "ok",
      },
    ]);
    setup.close();
  });

  test("失敗時は状態コードで始まるエラーが入り、usage がなければトークン数は NULL（US4-2）", async () => {
    const setup = createTestGateDeps({ responses: [{ httpError: 400 }] });
    await callGated(setup);
    expect(rows(setup)).toMatchObject([
      {
        status: "error",
        error_kind: "permanent",
        error: expect.stringMatching(/^400\b/),
        input_tokens: null,
        output_tokens: null,
      },
    ]);
    setup.close();
  });

  test("エラー文の APIキーの値と Bearer トークンは、記録にも errorMessage にも残らない（US4-3・SC-005）", async () => {
    const body = JSON.stringify({
      error: { message: `invalid key ${TEST_API_KEY}; header was Bearer sk-live.abc123` },
    });
    const setup = createTestGateDeps({ responses: [{ httpError: 401, body }] });
    const { message } = await callGated(setup);
    const recorded = rows(setup)[0]?.error ?? "";
    for (const text of [recorded, message.errorMessage ?? ""]) {
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(TEST_API_KEY);
      expect(text).not.toContain("sk-live.abc123");
    }
    setup.close();
  });

  test("記録に失敗したら、LLM の応答が成功していても呼び出しは失敗になる（Edge）", async () => {
    const setup = createTestGateDeps({ responses: [{ text: "成功した応答" }] });
    setup.sqlite.exec(
      "CREATE TRIGGER fail_llm_calls BEFORE INSERT ON llm_calls BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;",
    );
    const { events, message } = await callGated(setup);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("llm_calls の記録に失敗しました");
    expect(setup.fake.requests).toHaveLength(1);
    setup.close();
  });
});
