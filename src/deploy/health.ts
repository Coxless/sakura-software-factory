/**
 * ステージングのヘルスチェック（010 research R6）。全体の時間の上限の中で、200 が決まった回数続けば通過。
 * 起動の途中（接続の拒否）は失敗と数えて数え直すだけで、上限までは待つ。1回だけ通ってすぐ落ちるアプリを通さない
 */

export interface HealthResult {
  healthy: boolean;
  /** 送った要求の数 */
  attempts: number;
  /** 最後の応答の状態コード、または接続のエラー */
  last: string;
}

/** 1回の要求の時間の上限 */
const REQUEST_TIMEOUT_MS = 5000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? error.message;
  }
  return String(error);
}

export async function waitHealthy(req: {
  url: string;
  timeoutMs: number;
  intervalMs: number;
  successes: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}): Promise<HealthResult> {
  const doFetch = req.fetch ?? fetch;
  const sleep = req.sleep ?? defaultSleep;
  const now = req.now ?? Date.now;
  const deadline = now() + req.timeoutMs;
  let attempts = 0;
  let streak = 0;
  let last = "未実行";

  while (!req.signal?.aborted) {
    attempts += 1;
    try {
      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (req.signal) signals.push(req.signal);
      const res = await doFetch(req.url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
      await res.body?.cancel().catch(() => undefined);
      last = String(res.status);
      streak = res.status === 200 ? streak + 1 : 0;
    } catch (error) {
      last = errorText(error);
      streak = 0;
    }
    if (streak >= req.successes) return { healthy: true, attempts, last };
    if (now() + req.intervalMs > deadline) break;
    await sleep(req.intervalMs, req.signal);
  }
  if (req.signal?.aborted) last = "中断しました";
  return { healthy: false, attempts, last };
}
