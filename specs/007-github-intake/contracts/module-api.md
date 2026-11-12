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
  /** Issue の題と本文（jobs に保存しないので Worker が準備のときに取る）。本文が null なら空文字 */
  getIssue(req: { repo: string; issueNumber: number }): Promise<{ title: string; body: string }>;
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
type FailureKind = "clone_failed" | "install_failed" | "pipeline_failed" | "judge_rejected" | "budget_exceeded"
  | "timeout" | "shipping_not_available" | "restarted" | "stopped" | "internal_error";

/** 状態を1つ進める。表にない遷移・現在の状態が from でないときは StateTransitionError */
function transition(db: Db, jobId: number, from: JobStatus, to: JobStatus, now: number, detail?: object): Job;
function canTransition(from: JobStatus, to: JobStatus): boolean;

/** 005 の入口（runPipelineInSandbox と同じ形）。PipelineInput・PipelineResult は src/pipeline/run.ts のもの */
type PipelinePort = (input: Omit<PipelineInput, "workspace">) => Promise<PipelineResult>;

/** 005 の結果を分類する（research R2 の表）。passed は shipping_not_available、rejected は judge_rejected など */
function classifyOutcome(result: PipelineResult): { kind: FailureKind; detail: string };

/** onPhase の中身。現在の状態と同じなら何もしない。表にない遷移は warn のログだけで例外を投げない */
function advancePhase(deps: WorkerDeps, jobId: number, phase: PipelinePhase): void;

interface WorkerDeps {
  db: Db; config: FactoryConfig; logger: Logger; github: GitHubPort; pipeline: PipelinePort;
  /**
   * 003 の依存のインストール（installDependencies に ["sh", "-c", config.pipeline.install_command]）。
   * 終了コードと標準エラーの末尾を返す。install_command が空なら Worker は呼ばない。テストでは偽物
   */
  install: (jobId: number, workdir: string) => Promise<{ exitCode: number; stderrTail: string }>;
  /**
   * 003 の作業場の片付け（removeStaleSandboxes）。jobId を省くと全部。
   * 停止の合図・期限で、インストール中のコンテナを消して install を戻らせるのにも使う（research R11）。テストでは偽物
   */
  removeSandboxes: (jobId?: number) => Promise<void>;
  now?: () => number;
  /** ジョブの期限の長さ。既定は [limits] job_timeout_minutes。テストで短くする */
  jobTimeoutMs?: number;
  /** stop() が処理中のジョブを待つ上限。既定 5000。過ぎたら状態を変えずに resolve（research R11） */
  stopTimeoutMs?: number;
  /** 取得元。既定は https://github.com。テストでは file:// の bare リポジトリ */
  cloneBaseUrl?: string;
}

interface Worker {
  start(): void;
  /** 受付が積んだときに呼ぶ。待ちを打ち切ってすぐ取り出す */
  wake(): void;
  /** 取り出しを止め、処理中のジョブを中断して failed（stopped）にしてから resolve。stopTimeoutMs を過ぎたら状態を変えずに resolve */
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
/**
 * 積む。(repo, trigger_comment_id) が既にあれば積まずに既存のジョブを返す。
 * note を渡すと、新しく積んだときだけ job_events の note（受付の記録）を同じトランザクションで書く
 */
function enqueueJob(db: Db, request: NewJobInput, now: number, note?: object): { job: Job; created: boolean };
/** その月の受付を止めた時刻を記録する（既に記録があれば何もしない） */
function markIntakeStopped(db: Db, config: FactoryConfig, now: number): void;
/** 起動時の掃除の対象（planning〜judging） */
function listInterruptedJobs(db: Db): Job[];
```

## `src/main.ts`

```ts
/** 受付と Worker が使う外の世界。本物は createServices（octokit・runPipelineInSandbox・installDependencies） */
interface FactoryServices {
  github: GitHubPort;
  webhookSecret: string;
  pipeline: PipelinePort;
  install: WorkerDeps["install"];
  removeSandboxes: WorkerDeps["removeSandboxes"];
  cloneBaseUrl?: string;
}

/**
 * makeServices を渡すと、起動時の掃除 → Worker の開始 → /webhook 付きの待ち受けの順に始める。
 * 005 の入口は開いた DB を使うので、DB を受け取って依存を返す関数で渡す。省くと HTTP（/healthz）だけ（006 のテスト）。
 * stop() は Worker → HTTP → 応答のあとの処理 → DB の順に止める
 */
function startFactory(config: FactoryConfig, logger: Logger, makeServices?: (db: Db) => FactoryServices): Promise<RunningFactory>;
```

