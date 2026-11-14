# Contract: モジュールの関数と型（009）

## `src/github/port.ts`（GitHubPort の追加）

```ts
interface GitHubPort {
  // …007・008 の操作…

  /** PR の状態・Draft・auto-merge・head の commit・本文。失敗は例外 */
  getPullRequest(req: { repo: string; number: number }): Promise<PullRequestState>;

  /** commit に付いたチェック（filter=latest、全ページ）。失敗は例外 */
  getCheckRuns(req: { repo: string; sha: string }): Promise<CheckRunInfo[]>;

  /**
   * 失敗したチェックのログ。GitHub Actions のチェックはジョブのログ（プレーンテキスト）、
   * それ以外・取れないときは output の title・summary・text。何もなければ undefined。失敗も undefined（例外にしない）
   */
  getCheckRunLog(req: { repo: string; check: CheckRunInfo }): Promise<string | undefined>;
}
```

- 本物（`client.ts`）: `GET /repos/{o}/{r}/pulls/{n}`（`auto_merge` が null でなければ `autoMerge`）、`octokit.paginate("GET /repos/{o}/{r}/commits/{sha}/check-runs", { filter: "latest", per_page: 100 })`、`GET /repos/{o}/{r}/actions/jobs/{id}/logs`・`GET /repos/{o}/{r}/check-runs/{id}`
- 偽物（`testing.ts`）: `checkRuns`（sha → 一覧）・`checkLogs`（id → 文）を持たせる。PR に `state`・`merged`・`headSha` を持つ。`mergePullRequest(number)`・`closePullRequest(number)` で状態を変えられる

## `src/github/events.ts`

```ts
/** check_suite・pull_request のペイロードから CI の知らせを取り出す。扱わない action なら ignored。項目が欠けていれば PayloadError */
function toCiEvent(event: string, payload: unknown):
  | { kind: "event"; event: CiEvent }
  | { kind: "ignored"; reason: "event" | "action" };
```

## `src/github/git.ts`

```ts
/**
 * やり直しのために作業ブランチを取る（深さの制限なし、single-branch）。base の commit が履歴にあることを確かめる。
 * トークンは環境変数で渡す（cloneForJob と同じ）。失敗は CloneError
 */
function cloneBranchForRetry(req: {
  repo: string; token: string; branch: string; baseSha: string; dir: string;
  signal?: AbortSignal; baseUrl?: string; run?: GitRunner;
}): Promise<{ head: string }>;
```

## `src/queue/jobs.ts`

```ts
/** やり直しを待つ ci_waiting を先に implementing にし（ci_retries + 1）、なければ queued を planning にする */
function claimNextJob(db: Db, now: number): { kind: "new" | "ci_retry"; job: Job } | undefined;

/** 受付: 結び付くジョブに ci_event_at を入れ、ci_event を記録する。結び付かなければ undefined */
function noteCiEvent(db: Db, event: CiEvent, now: number, delivery: string): Job | undefined;

/** 見回りの対象: ci_waiting で、ci_event_at あり、または ci_status = pending で期限切れ */
function listCiJobsToCheck(db: Db, now: number): Job[];

/** 起動時: pending の ci_waiting すべてに ci_event_at を入れる */
function markPendingCiJobs(db: Db, now: number): number;
```

## `src/pipeline/ci.ts`

```ts
type CiConclusion =
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "failure"; failed: { name: string; conclusion: string }[] };

/** research R1 の決め方（純粋な関数） */
function concludeCi(runs: readonly CheckRunInfo[]): CiConclusion;

interface CiMonitorDeps extends ReportDeps {
  /** やり直しの印を付けたら Worker を起こす */
  wakeWorker: () => void;
  /** 見回りの間隔。既定は [worker].ci_check_interval_seconds */
  intervalMs?: number;
}

interface CiMonitor {
  start(): void;          // 起動時の取り直しの印を付けてからループを始める
  wake(): void;           // 受付が呼ぶ
  stop(): Promise<void>;  // 評価中の1件が終わるまで待つ
}
function createCiMonitor(deps: CiMonitorDeps): CiMonitor;

/** 1件を評価する（テスト用に公開）。例外を投げない */
function checkCiJob(deps: CiMonitorDeps, job: Job):
  Promise<"merged" | "closed" | "passed" | "retry" | "failed" | "timeout" | "pending" | "skipped">;

/** PR の本文の CI の欄を作り直して書く。失敗は ci_body_failed に残す */
function refreshCiSection(deps: ReportDeps, job: Pick<Job, "id" | "repo" | "pr_number">): Promise<void>;
```

## `src/pipeline/ci-log.ts`

```ts
/** research R8 の切り詰め（時刻・色の除去 → 失敗の行の前後 → マスク → 上限） */
function truncateCiLog(text: string, maxChars: number): string;

/** report.md 3章の Feedback[]（CI の失敗と前回の diff。工程内テストの結果は 005 が足す） */
function ciFeedback(input: {
  failed: { name: string; conclusion: string; log: string | undefined }[];
  diff: string;
  config: FactoryConfig;
}): Feedback[];
```

## `src/pipeline/run.ts`（`PipelineInput` の追加）

data-model.md 6章。`preflightChecks` の結果は `initialFeedback` の1番目（CI の失敗）のあとに入れる。

## `src/pipeline/ship.ts`（`ShipInput` の追加）

```ts
interface ShipInput {
  // …008…
  /** やり直しの出荷。ありなら PR を作らず、早送りで push し、振り分けは格下げだけ（research R11） */
  update?: { baseSha: string; prNumber: number };
}

type ShipOutcome =
  | { kind: "shipped"; prNumber: number; prUrl: string; decision: MergeDecisionKind }
  | { kind: "failed"; failure: /* 008 の分類 */ | "ci_unfixed" | "pr_closed" };
```

- 最初の出荷でも、遷移と同じトランザクションで `base_sha`（commit の親）・`head_sha`・`ci_status = 'pending'`・`ci_deadline` を書く（`TransitionFields` に足す）
- `shipped` の記録に `plan`・`plan_text` を足す

## `src/pipeline/worker.ts`

- `claimNextQueuedJob` の代わりに `claimNextJob` を使う
- `kind == "ci_retry"`: 作業ブランチを `cloneBranchForRetry` で取り、依存をインストールし、最新の `shipped` の記録から計画を読み、`getCheckRuns(head_sha)` → 失敗したチェックのログ（最大 5 件）→ `ciFeedback` → 005 の入口（`plan`・`planObject`・`baseCommit`・`initialFeedback`・`preflightChecks: true`、期限は取り出した時刻 ＋ `job_timeout_minutes`）→ 合格なら `shipJob({ update })`、それ以外は 007 の分類で `failJob`
- 記録に計画がない・`base_sha` がない → `failed`（`internal_error`）

## `src/pipeline/report.ts`

- `FAILURE_KINDS` に `ci_failed`・`ci_timeout`・`ci_unfixed`・`pr_closed`
- `failJob`: Issue への報告のあと、`pr_number` があり `pr_closed` でなければ引き渡し（research R13）
- `renderCiSection(events)`・`replaceCiSection(body, section)`
- `FailJobExtra`・`FailureReport` に `failedChecks?: { name; conclusion }[]`。PR の番号と CI のやり直しの回数はジョブの行から書く

## `src/main.ts`

- 起動時の掃除のあとに `createCiMonitor` を作り、`start()`。受付に `wakeCi` を渡す。停止は Worker → 見回り → HTTP の順
