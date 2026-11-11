import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { type ServerHandle, startServer } from "./server.ts";

const handles: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

function testApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // 停止のときに処理中の要求として残すための遅いルート
  app.get("/slow", () => new Promise<Response>(() => {}));
  return app;
}

async function start(app = testApp(), shutdownTimeoutSeconds = 1): Promise<ServerHandle> {
  const handle = await startServer({ app, host: "127.0.0.1", port: 0, shutdownTimeoutSeconds });
  handles.push(handle);
  return handle;
}

function urlOf(handle: ServerHandle, path: string): string {
  return `http://127.0.0.1:${handle.address.port}${path}`;
}

describe("startServer", () => {
  test("ポート 0 で起動し、実際のポートで応答する", async () => {
    const handle = await start();
    expect(handle.address.port).toBeGreaterThan(0);
    const res = await fetch(urlOf(handle, "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("close() のあとは接続を受け付けない。2回呼んでも投げない", async () => {
    const handle = await start();
    const url = urlOf(handle, "/healthz");
    await handle.close();
    await expect(fetch(url)).rejects.toThrow();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  test("処理中の要求が残っていても、上限を過ぎたら close() が終わる", async () => {
    const handle = await start(testApp(), 1);
    const pending = fetch(urlOf(handle, "/slow")).catch((error: unknown) => error);
    // 要求がサーバーに届くまで待つ
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await handle.close();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
    expect(await pending).toBeInstanceOf(Error);
  });

  test("使用中のポートでは、アドレスとポートを含むエラーで失敗する", async () => {
    const first = await start();
    const port = first.address.port;
    await expect(
      startServer({ app: testApp(), host: "127.0.0.1", port, shutdownTimeoutSeconds: 1 }),
    ).rejects.toThrow(`127.0.0.1:${port}`);
  });
});
