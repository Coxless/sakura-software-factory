import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FactoryConfig } from "../config.ts";
import { PayloadError, toAgentRequest } from "../github/events.ts";
import { type AgentRequest, type GitHubPort, WRITE_PERMISSIONS } from "../github/port.ts";
import { verifySignature } from "../github/signature.ts";
import { canAcceptNewJob } from "../llm/budget.ts";
import type { Logger } from "../log.ts";
import { renderBudgetExhausted, renderUsage } from "../pipeline/report.ts";
import type { Db } from "../queue/db.ts";
import { enqueueJob, markIntakeStopped } from "../queue/jobs.ts";
import { jobEvents } from "../queue/schema.ts";

export interface WebhookDeps {
  db: Db;
  config: FactoryConfig;
  logger: Logger;
  github: GitHubPort;
  /** GITHUB_WEBHOOK_SECRET */
  secret: string;
  /** 積んだときに Worker の待ちを打ち切る */
  wake: () => void;
  now?: () => number;
  /** 権限の確認の時間の上限（既定 5000。research R5） */
  permissionTimeoutMs?: number;
}

export interface WebhookHandler {
  /** /webhook に付ける Hono のアプリ（POST /） */
  app: Hono;
  /** 応答のあとに回した処理（リアクション・コメント）がすべて終わるまで待つ（テストと停止用） */
  idle(): Promise<void>;
}

/** 応答の本文。内部の情報（例外の文・パス・設定値）は入れない（contracts/webhook.md） */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /webhook（contracts/webhook.md）。判定の順: 大きさ → 署名 → JSON → ping → 対象の絞り込み → @agent →
 * 許可ユーザーと権限 → 本文が空でない → 予算 → 積む。リアクション・コメント・wake は応答のあとに回す（SC-004）。
 */
export function createWebhookHandler(deps: WebhookDeps): WebhookHandler {
  const { db, config, logger, github, secret, wake } = deps;
  const now = deps.now ?? Date.now;
  const permissionTimeoutMs = deps.permissionTimeoutMs ?? 5000;
  const allowed = new Set(config.github.allowed_users.map((user) => user.toLowerCase()));
  const pending = new Set<Promise<void>>();

  /** 応答を返したあとに回す。失敗はログだけ（呼び出し側で記録が要るものは task の中で書く） */
  const defer = (label: string, delivery: string, task: () => Promise<void>) => {
    const promise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(task)
      .catch((error: unknown) => {
        logger.warn({ err: error, delivery }, `webhook: ${label}に失敗しました`);
      })
      .finally(() => pending.delete(promise));
    pending.add(promise);
  };

  const comment = (request: AgentRequest, label: string, body: string) =>
    defer(label, request.delivery, async () => {
      await github.createIssueComment({
        repo: request.repo,
        issueNumber: request.issueNumber,
        body,
      });
    });

  const app = new Hono();
  app.post(
    "/",
    bodyLimit({
      maxSize: config.github.webhook_max_body_kb * 1024,
      onError: (c) => c.json({ error: "payload_too_large" }, 413, NO_STORE),
    }),
    async (c) => {
      const event = c.req.header("x-github-event") ?? "";
      const delivery = c.req.header("x-github-delivery") ?? "";
      const raw = new Uint8Array(await c.req.arrayBuffer());
      if (!(await verifySignature(secret, raw, c.req.header("x-hub-signature-256")))) {
        logger.warn({ delivery, event }, "webhook: 署名が正しくありません");
        return c.json({ error: "invalid_signature" }, 401, NO_STORE);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        logger.warn({ delivery, event }, "webhook: JSON として解釈できません");
        return c.json({ error: "invalid_payload" }, 400, NO_STORE);
      }

      let parsed: ReturnType<typeof toAgentRequest>;
      try {
        parsed = toAgentRequest(event, delivery, payload, config.github.max_instruction_chars);
      } catch (error) {
        if (!(error instanceof PayloadError)) throw error;
        logger.warn({ delivery, event }, `webhook: ${error.message}`);
        return c.json({ error: "invalid_payload" }, 400, NO_STORE);
      }
      if (parsed.kind === "ping") return c.json({ result: "pong" }, 200, NO_STORE);
      if (parsed.kind === "ignored") {
        logger.info({ delivery, event, result: "ignored", reason: parsed.reason }, "webhook");
        return c.json({ result: "ignored" }, 202, NO_STORE);
      }

      // 許可ユーザーと権限（FR-009〜FR-011）。権限のない依頼には Issue で返事をしない
      const { request } = parsed;
      const base = {
        delivery,
        repo: request.repo,
        issue: request.issueNumber,
        author: request.author,
      };
      if (!allowed.has(request.author.toLowerCase())) {
        logger.info({ ...base, result: "ignored", reason: "not_allowed" }, "webhook");
        return c.json({ result: "ignored" }, 202, NO_STORE);
      }
      let permission: string;
      try {
        permission = await github.getPermission({
          repo: request.repo,
          user: request.author,
          signal: AbortSignal.timeout(permissionTimeoutMs),
        });
      } catch (error) {
        logger.error(
          { ...base, err: error },
          "webhook: 権限を確かめられません（App の Recent Deliveries から再送できます）",
        );
        return c.json({ error: "internal_error" }, 500, NO_STORE);
      }
      if (!(WRITE_PERMISSIONS as readonly string[]).includes(permission)) {
        logger.info({ ...base, result: "ignored", reason: "permission", permission }, "webhook");
        return c.json({ result: "ignored" }, 202, NO_STORE);
      }

      if (parsed.kind === "empty") {
        logger.info({ ...base, result: "usage" }, "webhook");
        comment(request, "使い方のコメント", renderUsage());
        return c.json({ result: "usage" }, 202, NO_STORE);
      }

      try {
        const at = now();
        const { accept, remaining } = canAcceptNewJob(db, config, at);
        if (!accept) {
          markIntakeStopped(db, config, at);
          logger.warn({ ...base, result: "budget_exhausted", remaining }, "webhook");
          comment(request, "予算切れのコメント", renderBudgetExhausted(config, remaining));
          return c.json({ result: "budget_exhausted" }, 202, NO_STORE);
        }

        const { job, created } = enqueueJob(
          db,
          {
            repo: request.repo,
            issue_number: request.issueNumber,
            trigger_comment_id: request.commentId,
            requested_by: request.author,
            instruction: request.instruction,
          },
          at,
          { kind: "accepted", delivery },
        );
        if (!created) {
          logger.info({ ...base, result: "duplicate", job: job.id }, "webhook");
          return c.json({ result: "duplicate", job: job.id }, 202, NO_STORE);
        }
        logger.info({ ...base, result: "queued", job: job.id }, "webhook");
        defer("Worker の起こし", delivery, async () => wake());
        defer("リアクション", delivery, async () => {
          try {
            await github.addReaction({
              repo: request.repo,
              commentId: request.commentId,
              content: "eyes",
            });
          } catch (error) {
            db.insert(jobEvents)
              .values({
                job_id: job.id,
                type: "error",
                detail: JSON.stringify({
                  kind: "reaction_failed",
                  message: error instanceof Error ? error.message : String(error),
                }),
                created_at: now(),
              })
              .run();
            throw error;
          }
        });
        return c.json({ result: "queued", job: job.id }, 202, NO_STORE);
      } catch (error) {
        logger.error(
          { ...base, err: error },
          "webhook: ジョブを積めません（App の Recent Deliveries から再送できます）",
        );
        return c.json({ error: "internal_error" }, 500, NO_STORE);
      }
    },
  );

  return {
    app,
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
