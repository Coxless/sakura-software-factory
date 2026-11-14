import { Writable } from "node:stream";
import Value from "typebox/value";
import { describe, expect, test } from "vitest";
import { createLogger } from "../log.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { styleHash } from "../status/render.ts";
import { type StatusSnapshot, StatusSnapshotSchema } from "../status/schema.ts";
import { createSeeder } from "../status/testing.ts";
import { createApp } from "./app.ts";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({ level: "info" }, stream);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, records };
}

function setup() {
  const handle = migratedMemoryDb();
  const { logger, records } = capture();
  const app = createApp({ sqlite: handle.sqlite, logger });
  return { app, handle, records };
}

describe("GET /healthz", () => {
  test("DB を読めれば 200 と ok", async () => {
    const { app, handle } = setup();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    handle.close();
  });

  test("HEAD は 200 で本文なし", async () => {
    const { app, handle } = setup();
    const res = await app.request("/healthz", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    handle.close();
  });

  test("DB を読めなければ 503 と unhealthy。本文に内部の情報を出さず、warn を1回出す", async () => {
    const { app, handle, records } = setup();
    handle.close();
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "unhealthy" });
    expect(text).not.toMatch(/database|connection|memory|Error/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const warns = records().filter((record) => record.level === 40);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ msg: "healthz failed" });
  });
});

describe("定義していないパスと例外", () => {
  test("404 と not_found。本文にパスを含まない", async () => {
    const { app, handle } = setup();
    const res = await app.request("/nope/secret-path");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "not_found" });
    expect(text).not.toContain("secret-path");
    handle.close();
  });

  test("ハンドラーの例外は 500 と internal_error。内容はログにだけ出す", async () => {
    const { app, handle, records } = setup();
    app.get("/boom", () => {
      throw new Error("内部の詳細 /srv/factory/data");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal_error" });
    expect(text).not.toContain("/srv/factory");
    expect(records().filter((record) => record.level === 50)).toHaveLength(1);
    handle.close();
  });
});

describe("GET /status（011）", () => {
  const NOW = Date.UTC(2026, 10, 14, 3);
  const IN = Date.UTC(2026, 9, 31, 15) + 60_000;
  const MARK = "MARKER-should-not-leak";

  function setupStatus() {
    const handle = migratedMemoryDb();
    const { logger, records } = capture();
    const app = createApp({
      sqlite: handle.sqlite,
      logger,
      status: { db: handle.db, timeZone: "Asia/Tokyo", monthlyLimit: 3000, now: () => NOW },
    });
    return { app, handle, records, seed: createSeeder(handle.db) };
  }

  function seedSecrets(seed: ReturnType<typeof createSeeder>) {
    const jobId = seed.job({
      status: "failed",
      created_at: IN,
      started_at: IN,
      finished_at: IN + 1000,
      instruction: `依頼 ${MARK}`,
      requested_by: `user-${MARK}`,
      failure_reason: `ci_failed: ${MARK}`,
    });
    seed.llmCall({
      job_id: jobId,
      created_at: IN,
      status: "error",
      error_kind: "permanent",
      error: MARK,
    });
    seed.run({ job_id: jobId, started_at: IN, error: MARK, trace_path: `traces/${MARK}.jsonl` });
    seed.deployment({
      status: "failed",
      failed_stage: "health",
      finished_at: IN,
      error: MARK,
      image_tag: `demo:${MARK}`,
      rolled_back: true,
      rolled_back_to: `demo:${MARK}-old`,
      rollback_healthy: true,
    });
  }

  test("HTML と安全のための見出し", async () => {
    const { app, handle, seed } = setupStatus();
    seed.llmCall({ created_at: IN });
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`style-src '${styleHash()}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
    expect(await res.text()).toContain("1 / 3000");
    handle.close();
  });

  test("?format=json はスキーマに合い、HTML と同じ数値。知らない形式は HTML", async () => {
    const { app, handle, seed } = setupStatus();
    for (let i = 0; i < 7; i++) seed.llmCall({ created_at: IN });
    const res = await app.request("/status?format=json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const body = (await res.json()) as StatusSnapshot;
    expect(Value.Check(StatusSnapshotSchema, body)).toBe(true);
    expect(body.consumption.requests).toBe(7);
    expect(await (await app.request("/status")).text()).toContain("7 / 3000");
    const other = await app.request("/status?format=xml");
    expect(other.headers.get("content-type")).toMatch(/^text\/html/);
    handle.close();
  });

  test("依頼の本文・エラー文・軌跡の場所・イメージ名は HTML にも JSON にも出ない（SC-004）", async () => {
    const { app, handle, seed } = setupStatus();
    seedSecrets(seed);
    const page = await (await app.request("/status")).text();
    const json = await (await app.request("/status?format=json")).text();
    expect(page).toContain("ci_failed");
    expect(page).not.toContain(MARK);
    expect(json).not.toContain(MARK);
    handle.close();
  });

  test("開いても LLM の呼び出しと予算の記録は増えない（SC-006）", async () => {
    const { app, handle, seed } = setupStatus();
    seed.llmCall({ created_at: IN });
    const count = () =>
      handle.sqlite
        .prepare("SELECT (SELECT count(*) FROM llm_calls) + (SELECT count(*) FROM budget) AS n")
        .get() as { n: number };
    const before = count().n;
    await app.request("/status");
    await app.request("/status?format=json");
    expect(count().n).toBe(before);
    handle.close();
  });

  test("POST は 404。status を渡さなければ GET も 404", async () => {
    const { app, handle } = setupStatus();
    expect((await app.request("/status", { method: "POST" })).status).toBe(404);
    handle.close();
    const plain = setup();
    expect((await plain.app.request("/status")).status).toBe(404);
    plain.handle.close();
  });

  test("DB を読めなければ 500。本文に内部の情報を出さず、error を1回出す", async () => {
    const { app, handle, records } = setupStatus();
    handle.close();
    const res = await app.request("/status");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(records().filter((r) => r.msg === "status failed")).toHaveLength(1);
  });
});
