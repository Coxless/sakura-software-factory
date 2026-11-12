import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { GitHubPort, RepoPermission } from "./port.ts";

type Method = keyof GitHubPort;

export interface FakeGitHubOptions {
  /** ユーザー名（小文字）→ 権限。ないユーザーは none */
  permissions?: Record<string, RepoPermission>;
  /** 失敗させる操作 */
  fail?: Partial<Record<Method, Error>>;
  /** 応答を遅らせる操作（ミリ秒）。signal で打ち切れる */
  delayMs?: Partial<Record<Method, number>>;
  token?: string;
  defaultBranch?: string;
  issue?: { title: string; body: string };
}

export interface FakeCall {
  method: Method;
  args: Record<string, unknown>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** テスト用の偽の GitHub。呼ばれた操作を記録する */
export class FakeGitHub implements GitHubPort {
  readonly calls: FakeCall[] = [];
  readonly comments: { repo: string; issueNumber: number; body: string }[] = [];
  readonly options: FakeGitHubOptions;

  constructor(options: FakeGitHubOptions = {}) {
    this.options = options;
  }

  private async enter(method: Method, args: Record<string, unknown>, signal?: AbortSignal) {
    this.calls.push({ method, args });
    const delay = this.options.delayMs?.[method];
    if (delay) await sleep(delay, signal);
    const error = this.options.fail?.[method];
    if (error) throw error;
  }

  /** その操作が呼ばれた回数 */
  count(method: Method): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  async getPermission(req: { repo: string; user: string; signal?: AbortSignal }) {
    await this.enter("getPermission", { repo: req.repo, user: req.user }, req.signal);
    return this.options.permissions?.[req.user.toLowerCase()] ?? "none";
  }

  async addReaction(req: { repo: string; commentId: number; content: "eyes" }) {
    await this.enter("addReaction", req);
  }

  async createIssueComment(req: { repo: string; issueNumber: number; body: string }) {
    await this.enter("createIssueComment", req);
    this.comments.push(req);
    return `https://github.com/${req.repo}/issues/${req.issueNumber}#issuecomment-${this.comments.length}`;
  }

  async getCloneAccess(req: { repo: string }) {
    await this.enter("getCloneAccess", req);
    return {
      token: this.options.token ?? "ghs_FakeInstallationToken0123456789abcd",
      defaultBranch: this.options.defaultBranch ?? "main",
    };
  }

  async getIssue(req: { repo: string; issueNumber: number }) {
    await this.enter("getIssue", req);
    return this.options.issue ?? { title: "README を直す", body: "インストール手順が古い" };
  }
}

/** X-Hub-Signature-256 の値（sha256=<hex>） */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** 署名付きの Webhook の要求（Hono の app.request に渡す） */
export function signedRequest(
  secret: string,
  event: string,
  payload: unknown,
  delivery = "delivery-1",
): RequestInit {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": signBody(secret, body),
    },
    body,
  };
}

/**
 * 一時ディレクトリに <root>/octo-org/demo.git（既定のブランチ main、コミット1つ）を作る。
 * cloneForJob の baseUrl に file://<root> を渡して使う
 */
export async function createBareRepo(): Promise<{ baseUrl: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "factory-git-"));
  const work = join(root, "seed");
  mkdirSync(work);
  const git = (...args: string[]) => execa("git", args, { cwd: work });
  await git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(work, "README.md"), "# demo\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=seed",
    "-c",
    "user.email=seed@example.invalid",
    "commit",
    "-qm",
    "init",
  );
  mkdirSync(join(root, "octo-org"));
  await execa("git", ["clone", "--quiet", "--bare", work, join(root, "octo-org", "demo.git")]);
  return { baseUrl: `file://${root}`, root };
}
