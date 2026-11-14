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
  /**
   * Issue の題・本文・ラベルの名前（jobs に保存しないので Worker が準備のときに取る。008 の出荷前チェックは
   * PR を作る直前に取り直してラベルを見る）。本文が null なら空文字
   */
  getIssue(req: { repo: string; issueNumber: number }): Promise<IssueInfo>;
  /**
   * commit の作成者に使う App のボット（008 research R7）。App の JWT で呼べるのは /app 系だけなので、
   * ボットのアカウントの ID はリポジトリのインストールの認証で引く
   */
  getBotIdentity(req: { repo: string }): Promise<BotIdentity>;
  /** PR を作る。Draft を作れない（422 で Draft が使えない）ときは DraftUnavailableError */
  createPullRequest(req: CreatePullRequest): Promise<PullRequestRef>;
  /** auto-merge（squash）を有効にする。失敗は例外（message は GitHub の理由） */
  enableAutoMerge(req: { repo: string; nodeId: string }): Promise<void>;
  /** PR を Draft に変える。失敗は例外 */
  convertToDraft(req: { repo: string; nodeId: string }): Promise<void>;
  /** PR の本文を書き直す（振り分けが変わったとき。009・010 の書き足しにも使う）。失敗は例外 */
  updatePullRequestBody(req: { repo: string; number: number; body: string }): Promise<void>;
  /** PR の状態・Draft・auto-merge・head の commit・本文（009）。失敗は例外 */
  getPullRequest(req: { repo: string; number: number }): Promise<PullRequestState>;
  /** commit に付いたチェック（最新の実行だけ、全ページ。009）。失敗は例外 */
  getCheckRuns(req: { repo: string; sha: string }): Promise<CheckRunInfo[]>;
  /**
   * 失敗したチェックのログ（009 research R7）。GitHub Actions のチェックはジョブのログ、
   * それ以外・取れないときはチェックの output の文。何もない・失敗なら undefined（例外にしない）
   */
  getCheckRunLog(req: { repo: string; check: CheckRunInfo }): Promise<string | undefined>;
  /** マージ commit が sha の、マージ済みの PR の番号。なければ undefined。失敗は例外（010 research R3） */
  findMergedPullRequest(req: { repo: string; sha: string }): Promise<number | undefined>;
  /** 既定のブランチの名前と先頭の commit。失敗は例外（010 research R9） */
  getDefaultBranchHead(req: { repo: string }): Promise<{ branch: string; sha: string }>;
}

/** Webhook から取り出した push の知らせ（010） */
export interface PushEvent {
  /** owner/name */
  repo: string;
  /** refs/heads/main など */
  ref: string;
  defaultBranch: string;
  /** 0 だけならブランチの作成 */
  before: string;
  after: string;
  deleted: boolean;
}

/** PR の状態（009） */
export interface PullRequestState {
  number: number;
  url: string;
  nodeId: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** auto-merge が有効か */
  autoMerge: boolean;
  headSha: string;
  body: string;
}

/** commit に付いたチェック1件（009） */
export interface CheckRunInfo {
  id: number;
  name: string;
  /** queued・in_progress・completed など */
  status: string;
  /** success・failure など。終わっていなければ null */
  conclusion: string | null;
  /** チェックを作った App の slug（github-actions など） */
  app: string | null;
}

/** Webhook から取り出した CI の知らせ（009） */
export type CiEvent =
  | { kind: "check_suite"; repo: string; headBranch: string | null; headSha: string }
  | { kind: "pull_request_closed"; repo: string; prNumber: number; merged: boolean };

export interface IssueInfo {
  title: string;
  body: string;
  labels: string[];
}

/** { name: "<slug>[bot]", email: "<id>+<slug>[bot]@users.noreply.github.com" } */
export interface BotIdentity {
  name: string;
  email: string;
}

export interface CreatePullRequest {
  repo: string;
  /** 作業ブランチ */
  head: string;
  /** 既定のブランチ */
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequestRef {
  number: number;
  url: string;
  /** GraphQL の ID（auto-merge・Draft への変更に使う） */
  nodeId: string;
}

/** このリポジトリでは Draft PR を作れない（GitHub の無料プランの非公開リポジトリなど） */
export class DraftUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftUnavailableError";
  }
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
