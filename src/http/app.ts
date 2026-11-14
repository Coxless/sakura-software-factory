import type Database from "better-sqlite3";
import { Hono } from "hono";
import type { Logger } from "../log.ts";
import type { Db } from "../queue/db.ts";
import { collectStatus } from "../status/collect.ts";
import { renderStatusHtml, styleHash } from "../status/render.ts";

export interface AppDeps {
  /** 生存確認で SELECT 1 を実行する接続 */
  sqlite: Database.Database;
  logger: Logger;
  /** POST /webhook のアプリ（007 の createWebhookHandler）。省くと /webhook は 404 */
  webhook?: Hono;
  /** GET /status（011）。省くと /status は 404 */
  status?: StatusDeps;
}

export interface StatusDeps {
  db: Db;
  /** 月の区切り（[budget].timezone） */
  timeZone: string;
  /** [budget].monthly_requests */
  monthlyLimit: number;
  now?: () => number;
}

/** 外に返す本文。内部の情報（パス・エラー文・設定値）は入れない（contracts/http.md） */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * 状況ページの見出し（011 contracts/http-status.md）。スクリプト・外部の読み込み・埋め込みを許さない。
 * CSS は render.ts の <style> 1つだけで、そのハッシュだけを許す
 */
const STATUS_HEADERS = {
  ...NO_STORE,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": `default-src 'none'; style-src '${styleHash()}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
} as const;

/**
 * ファクトリーの HTTP アプリ。ルートの定義だけを持ち、待ち受けは server.ts が行う。
 * Caddy が転送するのは /healthz・/webhook・/status だけ（deploy/Caddyfile）。
 */
export function createApp({ sqlite, logger, webhook, status }: AppDeps): Hono {
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

  // 状況ページ。DB を読むだけで、LLM を呼ばない（予算を消費しない）。外からは Caddy の Basic 認証を通ったものだけが届く
  if (status) {
    app.get("/status", async (c) => {
      try {
        const snapshot = collectStatus(status.db, {
          now: (status.now ?? Date.now)(),
          timeZone: status.timeZone,
          monthlyLimit: status.monthlyLimit,
        });
        if (c.req.query("format") === "json") return c.json(snapshot, 200, STATUS_HEADERS);
        return c.html(await renderStatusHtml(snapshot), 200, STATUS_HEADERS);
      } catch (error) {
        logger.error({ err: error }, "status failed");
        return c.json({ error: "internal_error" }, 500, STATUS_HEADERS);
      }
    });
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    logger.error({ err: error, path: c.req.path }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
