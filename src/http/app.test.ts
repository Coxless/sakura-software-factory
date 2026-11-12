import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLogger } from "../log.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
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
