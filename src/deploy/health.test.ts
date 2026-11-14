import { describe, expect, test } from "vitest";
import { waitHealthy } from "./health.ts";

/** 応答の列を返す偽の fetch（数値は状態コード、文字列は接続のエラー）。尽きたら最後を繰り返す */
function fakeFetch(script: (number | string)[]) {
  const urls: string[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (typeof step === "string") {
      throw new TypeError("fetch failed", { cause: { code: step } });
    }
    return new Response("x", { status: step as number });
  }) as typeof fetch;
  return { fn, urls };
}

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const base = {
  url: "http://127.0.0.1:3100/healthz",
  timeoutMs: 20_000,
  intervalMs: 2000,
  successes: 3,
};

describe("waitHealthy（010 research R6）", () => {
  test("200 が3回続けば通過", async () => {
    const f = fakeFetch([200]);
    const c = clock();
    expect(await waitHealthy({ ...base, fetch: f.fn, ...c })).toEqual({
      healthy: true,
      attempts: 3,
      last: "200",
    });
    expect(f.urls).toEqual([base.url, base.url, base.url]);
  });

  test("接続の拒否のあとに通過する", async () => {
    const f = fakeFetch(["ECONNREFUSED", "ECONNREFUSED", 200, 200, 200]);
    const result = await waitHealthy({ ...base, fetch: f.fn, ...clock() });
    expect(result).toEqual({ healthy: true, attempts: 5, last: "200" });
  });

  test("途中で落ちたら数え直す", async () => {
    const f = fakeFetch([200, 500, 200, 200, 200]);
    const result = await waitHealthy({ ...base, fetch: f.fn, ...clock() });
    expect(result).toEqual({ healthy: true, attempts: 5, last: "200" });
  });

  test("上限まで通らなければ healthy: false と最後の状態", async () => {
    const f = fakeFetch([500]);
    const result = await waitHealthy({ ...base, fetch: f.fn, ...clock() });
    expect(result.healthy).toBe(false);
    expect(result.last).toBe("500");
    // 0, 2, …, 20 秒の 11 回
    expect(result.attempts).toBe(11);
  });

  test("1回だけ通ってすぐ落ちるアプリは通らない", async () => {
    const f = fakeFetch([200, "ECONNRESET"]);
    const result = await waitHealthy({ ...base, fetch: f.fn, ...clock() });
    expect(result).toMatchObject({ healthy: false, last: "ECONNRESET" });
  });

  test("signal で打ち切る", async () => {
    const controller = new AbortController();
    const f = fakeFetch([500]);
    const c = clock();
    const result = await waitHealthy({
      ...base,
      fetch: f.fn,
      now: c.now,
      sleep: async (ms) => {
        await c.sleep(ms);
        controller.abort();
      },
      signal: controller.signal,
    });
    expect(result).toEqual({ healthy: false, attempts: 1, last: "中断しました" });
  });
});
