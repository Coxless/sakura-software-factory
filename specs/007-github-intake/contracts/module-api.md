# Contract: モジュールの関数と型（007）

## `src/github/`（GitHub 層。GitHub の型と octokit はこの中だけ）

```ts
/**
 * 受付と Worker が使う GitHub の操作。本物は client.ts、偽物は testing.ts。
 * リポジトリ（owner/name）から App のインストールを引いて使う（ジョブにはインストールの ID を保存しない）
 */
interface GitHubPort {
  /** 依頼者の権限。admin / maintain / write / triage / read / none */
  getPermission(req: { repo: string; user: string }): Promise<RepoPermission>;
  addReaction(req: { repo: string; commentId: number; content: "eyes" }): Promise<void>;
  /** コメントを投稿して URL を返す */
  createIssueComment(req: { repo: string; issueNumber: number; body: string }): Promise<string>;
  /** git に渡す短命のトークンと既定のブランチ */
  getCloneAccess(req: { repo: string }): Promise<{ token: string; defaultBranch: string }>;
}

/** 生の本文と署名のヘッダーを定数時間で比べる */
function verifySignature(secret: string, rawBody: Uint8Array, signatureHeader: string | undefined): Promise<boolean>;

/** issue_comment のペイロードから依頼を取り出す。依頼でなければ理由付きで返す */
function toAgentRequest(event: string, delivery: string, payload: unknown, maxChars: number):
  | { kind: "request"; request: AgentRequest }
  | { kind: "ignored"; reason: "event" | "action" | "pull_request" | "closed" | "bot" | "not_agent" }
  | { kind: "empty"; request: AgentRequest }
  | { kind: "ping" };

/** 依頼の判定（純粋関数）。本文の最初の空でない行が @agent なら、そのあとの本文を返す */
function parseAgentCommand(body: string): string | undefined;

/** トークンを環境変数で渡して取得し、作業ブランチを作る。エラーの文からトークンを伏せる */
function cloneForJob(req: { repo: string; token: string; defaultBranch: string; dir: string; branch: string;
  signal?: AbortSignal; baseUrl?: string /* テストでは file:// */ }): Promise<void>;
```

- インストールは `repo` から引き（`GET /repos/{owner}/{repo}/installation`）、プロセスの中で覚えておく。App が入っていなければ例外（受付では「権限の確認ができない」として扱う）

## `src/pipeline/`

```ts
type FailureKind = "clone_failed" | "install_failed" | "pipeline_failed" | "budget_exceeded" | "timeout"
  | "shipping_not_available" | "restarted" | "stopped" | "internal_error";

/** 状態を1つ進める。表にない遷移・現在の状態が from でないときは StateTransitionError */
function transition(db: Db, jobId: number, from: JobStatus, to: JobStatus, now: number, detail?: object): Job;
function canTransition(from: JobStatus, to: JobStatus): boolean;

/** 005 の入口（data-model.md の PipelinePort） */
type PipelinePort = (input: PipelineInput) => Promise<PipelineOutcome>;

interface WorkerDeps {
  db: Db; config: FactoryConfig; logger: Logger; github: GitHubPort; pipeline: PipelinePort;
  /** 003 の依存のインストール。テストでは偽物 */
  install: (workdir: string, signal: AbortSignal) => Promise<void>;
  /** 003 の作業場の片付け（removeStaleSandboxes）。jobId を省くと全部。テストでは偽物 */
  removeSandboxes: (jobId?: number) => Promise<void>;
  now?: () => number;
}

interface Worker {
  start(): void;
  /** 受付が積んだときに呼ぶ。待ちを打ち切ってすぐ取り出す */
  wake(): void;
  /** 取り出しを止め、処理中のジョブを中断して failed（stopped）にしてから resolve */
  stop(): Promise<void>;
}
function createWorker(deps: WorkerDeps): Worker;

/** 起動時の掃除。planning〜judging のジョブを failed（restarted）にして報告し、残った作業場と作業ディレクトリを消す */
function recoverOnStartup(deps: WorkerDeps): Promise<{ failedJobs: number }>;

/** 失敗にして報告する（1回だけ）。報告の失敗は job_events の error に残す */
function failJob(deps: WorkerDeps, job: Job, kind: FailureKind, message: string, extra?: { summary?: string }): Promise<void>;
```

## `src/queue/jobs.ts`（足すもの）

```ts
/** 積む。(repo, trigger_comment_id) が既にあれば積まずに既存のジョブを返す */
function enqueueJob(db: Db, request: NewJobInput, now: number): { job: Job; created: boolean };
/** その月の受付を止めた時刻を記録する（既に記録があれば何もしない） */
function markIntakeStopped(db: Db, config: FactoryConfig, now: number): void;
/** 起動時の掃除の対象（planning〜judging） */
function listInterruptedJobs(db: Db): Job[];
```
