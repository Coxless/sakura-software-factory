import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  type BotIdentity,
  type CheckRunInfo,
  type CreatePullRequest,
  DraftUnavailableError,
  type GitHubPort,
  type IssueInfo,
  type PullRequestRef,
  type PullRequestState,
  type RepoPermission,
} from "./port.ts";

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
  issue?: { title: string; body: string; labels?: string[] };
  bot?: BotIdentity;
  /** draft: true の PR の作成を DraftUnavailableError にする */
  draftUnavailable?: boolean;
  /** commit → チェックの一覧（009） */
  checkRuns?: Record<string, CheckRunInfo[]>;
  /** チェックの ID → ログ（009） */
  checkLogs?: Record<number, string>;
}

/** 偽の GitHub が持つ PR */
export interface FakePullRequest extends CreatePullRequest, PullRequestRef {
  autoMerge: boolean;
  /** 009 */
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
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
  readonly pullRequests: FakePullRequest[] = [];
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

  async getIssue(req: { repo: string; issueNumber: number }): Promise<IssueInfo> {
    await this.enter("getIssue", req);
    const issue = this.options.issue ?? { title: "README を直す", body: "インストール手順が古い" };
    return { title: issue.title, body: issue.body, labels: [...(issue.labels ?? [])] };
  }

  async getBotIdentity(req: { repo: string }): Promise<BotIdentity> {
    await this.enter("getBotIdentity", req);
    return (
      this.options.bot ?? {
        name: "factory-app[bot]",
        email: "1234+factory-app[bot]@users.noreply.github.com",
      }
    );
  }

  async createPullRequest(req: CreatePullRequest): Promise<PullRequestRef> {
    await this.enter("createPullRequest", { ...req });
    if (req.draft && this.options.draftUnavailable) {
      throw new DraftUnavailableError("Draft pull requests are not supported in this repository.");
    }
    const number = this.pullRequests.length + 1;
    const ref = {
      number,
      url: `https://github.com/${req.repo}/pull/${number}`,
      nodeId: `PR_node_${number}`,
    };
    this.pullRequests.push({
      ...req,
      ...ref,
      autoMerge: false,
      state: "open",
      merged: false,
      headSha: "",
    });
    return ref;
  }

  async enableAutoMerge(req: { repo: string; nodeId: string }): Promise<void> {
    await this.enter("enableAutoMerge", req);
    const pr = this.pullRequests.find((p) => p.nodeId === req.nodeId);
    if (!pr) throw new Error(`PR がありません: ${req.nodeId}`);
    pr.autoMerge = true;
  }

  async updatePullRequestBody(req: { repo: string; number: number; body: string }): Promise<void> {
    await this.enter("updatePullRequestBody", { repo: req.repo, number: req.number });
    const pr = this.pullRequests.find((p) => p.number === req.number);
    if (!pr) throw new Error(`PR がありません: ${req.number}`);
    pr.body = req.body;
  }

  async convertToDraft(req: { repo: string; nodeId: string }): Promise<void> {
    await this.enter("convertToDraft", req);
    const pr = this.pullRequests.find((p) => p.nodeId === req.nodeId);
    if (!pr) throw new Error(`PR がありません: ${req.nodeId}`);
    pr.draft = true;
  }

  async getPullRequest(req: { repo: string; number: number }): Promise<PullRequestState> {
    await this.enter("getPullRequest", req);
    const pr = this.pullRequests.find((p) => p.number === req.number);
    if (!pr) throw new Error(`PR がありません: ${req.number}`);
    return {
      number: pr.number,
      url: pr.url,
      nodeId: pr.nodeId,
      state: pr.state,
      merged: pr.merged,
      draft: pr.draft,
      autoMerge: pr.autoMerge,
      headSha: pr.headSha,
      body: pr.body,
    };
  }

  async getCheckRuns(req: { repo: string; sha: string }): Promise<CheckRunInfo[]> {
    await this.enter("getCheckRuns", req);
    return (this.options.checkRuns?.[req.sha] ?? []).map((run) => ({ ...run }));
  }

  async getCheckRunLog(req: { repo: string; check: CheckRunInfo }): Promise<string | undefined> {
    try {
      await this.enter("getCheckRunLog", { repo: req.repo, id: req.check.id });
    } catch {
      return undefined;
    }
    return this.options.checkLogs?.[req.check.id];
  }

  /** テスト用: commit のチェックを差し替える（009） */
  setCheckRuns(sha: string, runs: CheckRunInfo[]): void {
    this.options.checkRuns = { ...this.options.checkRuns, [sha]: runs };
  }

  /** テスト用: 既存の PR を足す（009。ジョブを ci_waiting から始めるテスト用） */
  addPullRequest(pr: Partial<FakePullRequest> & { number: number }): FakePullRequest {
    const full: FakePullRequest = {
      repo: "octo-org/demo",
      head: "agent/issue-1-job-1",
      base: "main",
      title: "t",
      body: "",
      draft: false,
      url: `https://github.com/octo-org/demo/pull/${pr.number}`,
      nodeId: `PR_node_${pr.number}`,
      autoMerge: false,
      state: "open",
      merged: false,
      headSha: "",
      ...pr,
    };
    this.pullRequests.push(full);
    return full;
  }

  /** テスト用: PR をマージ済みにする（009） */
  mergePullRequest(number: number): void {
    const pr = this.pullRequests.find((p) => p.number === number);
    if (!pr) throw new Error(`PR がありません: ${number}`);
    pr.state = "closed";
    pr.merged = true;
  }

  /** テスト用: PR をマージせずに閉じる（009） */
  closePullRequest(number: number): void {
    const pr = this.pullRequests.find((p) => p.number === number);
    if (!pr) throw new Error(`PR がありません: ${number}`);
    pr.state = "closed";
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
