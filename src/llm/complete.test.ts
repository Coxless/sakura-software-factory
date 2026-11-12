import { asc } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { jobs, llmCalls } from "../queue/schema.ts";
import { completeOnce } from "./complete.ts";
import type { CallContext } from "./stream.ts";
import { createTestGateDeps, TEST_API_KEY } from "./testing.ts";

function insertJob(setup: ReturnType<typeof createTestGateDeps>): number {
  const [row] = setup.db
    .insert(jobs)
    .values({
      repo: "local:demo",
      issue_number: 0,
      trigger_comment_id: 1,
      requested_by: "dev",
      instruction: "test",
      created_at: 1,
      updated_at: 1,
    })
    .returning()
    .all();
  return row?.id as number;
}

const planCtx = (jobId: number | null): CallContext => ({
  jobId,
  phase: "plan",
  role: "planner",
});

describe("completeOnce", () => {
  test("テキストを返し、llm_calls に工程・役割付きで1件。要求に tools がない", async () => {
    const setup = createTestGateDeps({ responses: [{ text: '{"ok":true}' }] });
    const jobId = insertJob(setup);
    const result = await completeOnce(setup.deps, planCtx(jobId), {
      role: "planner",
      systemPrompt: "あなたは計画役です",
      messages: [{ role: "user", text: "計画を立てて" }],
    });
    expect(result).toMatchObject({ ok: true, text: '{"ok":true}', model: "plan-model" });
    const rows = setup.db.select().from(llmCalls).orderBy(asc(llmCalls.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: jobId, phase: "plan", role: "planner" });
    const [request] = setup.fake.requests;
    expect(request?.model).toBe("plan-model");
    expect(request?.body).not.toHaveProperty("tools");
    expect(request?.tools).toBeUndefined();
    setup.close();
  });

  test("システムの指示と、user・assistant の本文がこの順で要求に入る", async () => {
    const setup = createTestGateDeps({ responses: [{ text: "2回目" }] });
    await completeOnce(setup.deps, planCtx(null), {
      role: "verifier",
      systemPrompt: "SYS",
      messages: [
        { role: "user", text: "最初" },
        { role: "assistant", text: "壊れた出力" },
        { role: "user", text: "直して" },
      ],
    });
    const messages = setup.fake.requests[0]?.messages as { role: string; content: unknown }[];
    const flat = messages.map((m) => [
      m.role,
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    ]);
    expect(flat[0]?.[0]).toMatch(/system|developer/);
    expect(flat[0]?.[1]).toContain("SYS");
    expect(flat.slice(1).map(([role]) => role)).toEqual(["user", "assistant", "user"]);
    expect(flat[2]?.[1]).toContain("壊れた出力");
    expect(setup.fake.requests[0]?.model).toBe("verify-model");
    setup.close();
  });

  test("ジョブの予算が尽きていると LLM を呼ばずに budgetExceeded", async () => {
    const setup = createTestGateDeps({
      responses: [{ text: "a" }, { text: "b" }],
      config: { budget: { per_job_requests: 1 } },
    });
    const jobId = insertJob(setup);
    await completeOnce(setup.deps, planCtx(jobId), {
      role: "planner",
      systemPrompt: "s",
      messages: [{ role: "user", text: "u" }],
    });
    const second = await completeOnce(setup.deps, planCtx(jobId), {
      role: "planner",
      systemPrompt: "s",
      messages: [{ role: "user", text: "u" }],
    });
    expect(second).toMatchObject({ ok: false, budgetExceeded: true, aborted: false });
    expect(setup.fake.requests).toHaveLength(1);
    setup.close();
  });

  test("signal の中止で aborted", async () => {
    const controller = new AbortController();
    const setup = createTestGateDeps({
      responses: [{ hang: true }],
      onHang: () => controller.abort(),
    });
    const result = await completeOnce(setup.deps, planCtx(null), {
      role: "planner",
      systemPrompt: "s",
      messages: [{ role: "user", text: "u" }],
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, aborted: true, budgetExceeded: false });
    setup.close();
  });

  test("回復できない HTTP エラーで ok: false と error（APIキーを含まない）。例外を投げない", async () => {
    const setup = createTestGateDeps({
      responses: [{ httpError: 401, body: `{"error":{"message":"bad key ${TEST_API_KEY}"}}` }],
    });
    const result = await completeOnce(setup.deps, planCtx(null), {
      role: "planner",
      systemPrompt: "s",
      messages: [{ role: "user", text: "u" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(TEST_API_KEY);
    setup.close();
  });

  test("モデルを引けない設定でも例外を投げない", async () => {
    const setup = createTestGateDeps();
    const result = await completeOnce(setup.deps, planCtx(null), {
      role: "verifier_alt",
      systemPrompt: "s",
      messages: [{ role: "user", text: "u" }],
    });
    expect(result).toMatchObject({ ok: false, model: "" });
    expect(result.error).toContain("verifier_alt");
    setup.close();
  });
});
