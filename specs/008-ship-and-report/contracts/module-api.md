# Contract: モジュールの関数と型（008）

## `src/github/port.ts`（GitHubPort の追加）

```ts
interface GitHubPort {
  // …007 の操作…

  /** Issue の題・本文・ラベルの名前（008 でラベルを足す）。本文が null なら空文字 */
  getIssue(req: { repo: string; issueNumber: number }): Promise<{ title: string; body: string; labels: string[] }>;

  /** commit の作成者に使う App のボット。{ name: "<slug>[bot]", email: "<id>+<slug>[bot]@users.noreply.github.com" } */
  getBotIdentity(): Promise<{ name: string; email: string }>;

  /** PR を作る。draft を作れない（422 で Draft が使えない）ときは DraftUnavailableError */
  createPullRequest(req: { repo: string; head: string; base: string; title: string; body: string; draft: boolean }):
    Promise<{ number: number; url: string; nodeId: string }>;

  /** auto-merge（squash）を有効にする。失敗は例外（message は GitHub の理由） */
  enableAutoMerge(req: { repo: string; nodeId: string }): Promise<void>;

  /** PR を Draft に変える。失敗は例外 */
  convertToDraft(req: { repo: string; nodeId: string }): Promise<void>;
}

class DraftUnavailableError extends Error {}
```

- 本物（`client.ts`）: `getBotIdentity` は App の JWT で `GET /app` → `GET /users/{slug}[bot]`、結果をプロセスの中で覚える。`createPullRequest` は REST、`enableAutoMerge`（`mergeMethod: SQUASH`）と `convertToDraft` は GraphQL
- 偽物（`testing.ts`）: 呼び出しを記録し、失敗させる操作を指定できる（`failOn`）。作った PR の一覧・auto-merge の状態・Draft の状態を持つ

## `src/github/git.ts`（commit と push の追加）

```ts
/** 作業ディレクトリの変更（005 の diff と同じ範囲）を1つの commit にする。トークンは使わない */
function commitForJob(req: {
  dir: string;
  message: string;
  author: { name: string; email: string };
  run?: GitRunner;
}): Promise<{ base: string; head: string }>;

/** <base>..<head> の変更したパス（名前の変更・コピーは変更前と変更後の両方）と行数 */
function changedFiles(req: { dir: string; base: string; head: string; run?: GitRunner }):
  Promise<{ paths: string[]; files: { path: string; oldPath?: string; status: string }[]; insertions: number; deletions: number; binary: number }>;

/** 作業ブランチだけを push する（強制しない）。トークンは環境変数で渡す。エラーの文からトークンを伏せる */
function pushBranch(req: {
  dir: string;
  repo: string;
  token: string;
  branch: string;
  signal?: AbortSignal;
  baseUrl?: string; // テストでは file://
  run?: GitRunner;
}): Promise<void>;

class ShipGitError extends Error {} // message はトークンを伏せ済み
```

- どの git の呼び出しも `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c core.quotePath=false` を付け、環境変数 `GIT_CONFIG_NOSYSTEM=1`・`GIT_CONFIG_GLOBAL=/dev/null`・`HOME=<一時ディレクトリ>`・`GIT_TERMINAL_PROMPT=0` で呼ぶ（research R2）
- `pushBranch` は `git push origin HEAD:refs/heads/<branch>`。`baseUrl` を渡したときは `origin` の代わりに `<baseUrl>/<repo>.git` に push する（テスト用）

## `src/pipeline/ship-checks.ts`

```ts
type ConditionName = "verdict" | "diff_size" | "forbidden_paths" | "secrets" | "skip_label" | "work_type";

interface Condition { name: ConditionName; met: boolean; value: unknown /* data-model.md の表 */ }

type SecretScan =
  | { status: "clean" }
  | { status: "found"; findings: { file: string; line: number; rule: string }[] }
  | { status: "unavailable"; error: string };

/** gitleaks を基準のコミットの設定で呼び、<base>..<head> の1つの commit を調べる（research R4） */
function scanSecrets(req: {
  dir: string; base: string; head: string;
  timeoutMs: number; signal?: AbortSignal;
  gitleaksPath?: string; // 既定 "gitleaks"
}): Promise<SecretScan>;

/** 追加行に gitleaks:allow を含むものを探す（research R4） */
function findInlineAllows(diffText: string): { file: string; line: number }[];

/** 6条件を評価し、push してよいかを決める。純粋関数（入力はすべて引数） */
function evaluateShipChecks(input: {
  config: FactoryConfig["auto_merge"];
  verdictPassed: boolean;
  workType: WorkType | undefined;
  changes: { paths: string[]; insertions: number; deletions: number };
  secrets: SecretScan;
  labels: { names: string[] } | { error: string };
}): { conditions: Condition[]; unmet: ConditionName[]; blocker: "secret_detected" | "unshippable_change" | null };
```

## `src/pipeline/ship.ts`

```ts
interface ShipDeps extends ReportDeps {
  /** gitleaks の実行ファイル。既定 "gitleaks" */
  gitleaksPath?: string;
  /** push 先。既定は https://github.com。テストでは file:// */
  cloneBaseUrl?: string;
}

interface ShipInput {
  job: Job;              // judging のジョブ
  workdir: string;
  branch: string;
  issue: { title: string };
  result: PipelineResult; // outcome == "passed"
  /** 停止の合図と期限。push の前だけ見る */
  interruption: () => "stopped" | "timeout" | undefined;
  secrets: string[];     // 伏せる値（Worker と共有。push のトークンを足す）
}

type ShipOutcome =
  | { kind: "shipped"; prNumber: number; prUrl: string; decision: "auto_merge" | "draft" | "unsettled" }
  | { kind: "failed"; failure: "secret_detected" | "unshippable_change" | "ship_failed" | "stopped" | "timeout" | "internal_error" };

/**
 * commit → 出荷前チェック → push → PR → 振り分け → 状態（ci_waiting）→ Issue に知らせる。
 * 失敗は failJob（007）で Issue に報告してから返す。例外を投げない
 */
function shipJob(deps: ShipDeps, input: ShipInput): Promise<ShipOutcome>;
```

## `src/pipeline/worker.ts` の変更

- `classifyOutcome` の `passed` を消し、Worker は `result.outcome === "passed"` なら `shipJob` を呼ぶ（そのほかは 007 のまま `failJob`）
- `WorkerDeps` に `gitleaksPath?` を足す（`ShipDeps` と同じ）
- 作業ディレクトリの片付け（`finally`）は出荷のあと

## `src/pipeline/report.ts` の追加

```ts
type FailureKind = /* 007 から shipping_not_available を除き */ | "secret_detected" | "unshippable_change" | "ship_failed";

/** PR の本文（まとめレポート）。contracts/report.md */
function renderShipReport(config: FactoryConfig, input: ShipReportInput): string;
/** Issue のコメント（PR へのリンク） */
function renderShipNotice(input: { jobId: number; prUrl: string; decision: MergeDecision["decision"]; unmet: ConditionName[]; requests: number }): string;

interface FailJobExtra {
  // …007…
  /** 作業ブランチを push 済みか（報告の作業ブランチの行） */
  pushed?: boolean;
  /** 出荷前チェックの結果（報告に止まった条件を書く） */
  conditions?: Condition[];
}
```
