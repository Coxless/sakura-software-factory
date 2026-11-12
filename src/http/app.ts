import type Database from "better-sqlite3";
import { Hono } from "hono";
import type { Logger } from "../log.ts";

export interface AppDeps {
  /** 生存確認で SELECT 1 を実行する接続 */
  sqlite: Database.Database;
  logger: Logger;
  /** POST /webhook のアプリ（007 の createWebhookHandler）。省くと /webhook は 404 */
  webhook?: Hono;
}

/** 外に返す本文。内部の情報（パス・エラー文・設定値）は入れない（contracts/http.md） */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * ファクトリーの HTTP アプリ。ルートの定義だけを持ち、待ち受けは server.ts が行う。
 * Caddy が転送するのは /healthz・/webhook・/status だけ（deploy/Caddyfile）。
 */
export function createApp({ sqlite, logger, webhook }: AppDeps): Hono {
  const app = new Hono();

  // 生存確認。DB を読めるかまで見る。LLM は呼ばない（予算を消費しない）。HEAD も同じ扱い
  app.get("/healthz", (c) => {
    try {
      sqlite.prepare("SELECT 1").get();
      return c.json({ status: "ok" }, 200, NO_STORE);
    } catch (error) {
      logger.warn({ err: error }, "healthz failed");
      return c.json({ status: "unhealthy" }, 503, NO_STORE);
    }
  });

  if (webhook) app.route("/webhook", webhook);

  // GET /status は 011 でここに足す

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    logger.error({ err: error, path: c.req.path }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
