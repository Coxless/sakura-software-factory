/**
 * GitHub 層の外に見せる型（原則 VII）。ほかの層はこのファイルの型と GitHubPort だけを使い、
 * octokit・@octokit/webhooks の型は src/github/ の外に出さない。
 */

/** リポジトリに対する依頼者の権限（GitHub の role_name） */
export const REPO_PERMISSIONS = ["admin", "maintain", "write", "triage", "read", "none"] as const;
export type RepoPermission = (typeof REPO_PERMISSIONS)[number];

/** ジョブを積んでよい権限（書き込み以上） */
export const WRITE_PERMISSIONS: readonly RepoPermission[] = ["admin", "maintain", "write"];

/** 受付と Worker が使う GitHub の操作。本物は client.ts、偽物は testing.ts */
export interface GitHubPort {
  /** 依頼者の権限。App が入っていない・API の失敗は例外 */
  getPermission(req: { repo: string; user: string; signal?: AbortSignal }): Promise<RepoPermission>;
  addReaction(req: { repo: string; commentId: number; content: "eyes" }): Promise<void>;
  /** コメントを投稿して URL を返す */
  createIssueComment(req: { repo: string; issueNumber: number; body: string }): Promise<string>;
  /** git に渡す短命のトークンと既定のブランチ */
  getCloneAccess(req: { repo: string }): Promise<{ token: string; defaultBranch: string }>;
  /** Issue の題と本文（jobs に保存しないので Worker が準備のときに取る）。本文が null なら空文字 */
  getIssue(req: { repo: string; issueNumber: number }): Promise<{ title: string; body: string }>;
}

/** Webhook から取り出した依頼（GitHub の型から変換したもの） */
export interface AgentRequest {
  /** X-GitHub-Delivery */
  delivery: string;
  /** owner/name */
  repo: string;
  issueNumber: number;
  commentId: number;
  author: string;
  /** @agent のあとの本文（切り詰め済み） */
  instruction: string;
}
