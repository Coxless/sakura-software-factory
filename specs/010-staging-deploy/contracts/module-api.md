# Contract: モジュールの API（010）

## 1. `src/github/port.ts`（GitHubPort に足す）

```ts
/** マージ commit が sha の、マージ済みの PR の番号。なければ undefined。失敗は例外 */
findMergedPullRequest(req: { repo: string; sha: string }): Promise<number | undefined>;
/** 既定のブランチの名前と先頭の commit。失敗は例外 */
getDefaultBranchHead(req: { repo: string }): Promise<{ branch: string; sha: string }>;
```

- 本物（`client.ts`）: `GET /repos/{owner}/{repo}/commits/{sha}/pulls` の中から `merged_at` があり `merge_commit_sha === sha` のもの。`GET /repos/{owner}/{repo}` の `default_branch` と `GET /repos/{owner}/{repo}/branches/{branch}` の `commit.sha`
- 偽物（`testing.ts`）: `FakePullRequest` に `mergeCommitSha` を足し、`mergePullRequest(number, mergeCommitSha?)` で入れる。`options.defaultBranchHead` で先頭を決める
- revert PR は既存の `createPullRequest`（`draft: false`）を使う

## 2. `src/github/events.ts`

```ts
export type PushEventResult = { kind: "event"; event: PushEvent } | { kind: "ignored"; reason: "event" };
export function toPushEvent(event: string, payload: unknown): PushEventResult; // 項目が欠けていれば PayloadError
```

## 3. `src/github/git.ts`

```ts
/** sha の commit のファイルを dir に取り出す（.git を残さない）。失敗は CloneError（トークンは伏せ済み） */
export function fetchCommit(req: { repo: string; token: string; sha: string; dir: string; signal?: AbortSignal; baseUrl?: string; run?: GitRunner }): Promise<void>;

export type RevertResult =
  | { kind: "created"; branch: string; head: string }
  | { kind: "skipped"; reason: "no_range" | "not_ancestor" | "not_in_branch" | "conflict" | "empty" };

/**
 * 既定のブランチの先頭に before..after を打ち消す1つの commit を作り、branch に push する（強制しない）。
 * 作らないときは skipped。git・push の失敗は ShipGitError / CloneError
 */
export function revertRange(req: {
  repo: string; token: string; defaultBranch: string; before: string | null; after: string;
  branch: string; message: string; author: { name: string; email: string }; dir: string;
  signal?: AbortSignal; baseUrl?: string; run?: GitRunner;
}): Promise<RevertResult>;
```

## 4. `src/queue/deployments.ts`

```ts
/** 積む。(repo, commit_sha) があれば積まずに既存を返す */
export function enqueueDeployment(db: Db, input: { repo: string; commitSha: string; beforeSha: string | null; imageTag: string }, now: number): { deployment: Deployment; created: boolean };
/** 最も古い queued を running にして返す（即時トランザクションの1文） */
export function claimNextDeployment(db: Db, now: number): Deployment | undefined;
/** running の行だけを終わらせる。変えたら true */
export function finishDeployment(db: Db, id: number, fields: FinishFields, now: number): boolean;
/** 同じリポジトリの succeeded のうち最も新しいもの（exceptId を除く） */
export function lastSucceededDeployment(db: Db, repo: string, exceptId?: number): Deployment | undefined;
/** 同じリポジトリの最も新しい記録（状態を問わない） */
export function latestDeployment(db: Db, repo: string): Deployment | undefined;
/** 起動時: running を failed（interrupted）にして、その行を返す */
export function interruptRunningDeployments(db: Db, now: number): Deployment[];
/** ジョブに結び付いたデプロイ（古い順。PR の本文のデプロイの欄） */
export function listDeploymentsForJob(db: Db, jobId: number): Deployment[];
```

## 5. `src/deploy/staging.ts`（Docker の操作）

```ts
export interface StagingRuntime {
  /** dir の Dockerfile で image を作る。失敗は DeployStepError（message は stderr の末尾、伏せ字済み） */
  build(req: { dir: string; image: string; signal?: AbortSignal }): Promise<void>;
  /** compose で image に入れ替える。失敗は DeployStepError */
  up(req: { image: string; signal?: AbortSignal }): Promise<void>;
  /** compose で止める。失敗は DeployStepError */
  down(req: { signal?: AbortSignal }): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  /** 消せなかったものは無視して、消したものを返す */
  removeImages(images: readonly string[]): Promise<string[]>;
}
export function createDockerStaging(config: FactoryConfig["staging"], options?: { composeFile?: string }): StagingRuntime;
export const STAGING_COMPOSE_FILE: string; // deploy/staging/compose.yaml の絶対パス
export function imageTagFor(config: FactoryConfig["staging"], sha: string): string;
```

## 6. `src/deploy/health.ts`

```ts
export function waitHealthy(req: {
  url: string; timeoutMs: number; intervalMs: number; successes: number;
  signal?: AbortSignal; fetch?: typeof fetch; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number;
}): Promise<HealthResult>;
```

## 7. `src/deploy/runner.ts`（デプロイの実行器）

```ts
export interface DeployerDeps extends ReportDeps {
  staging: StagingRuntime;
  health?: typeof waitHealthy;
  /** テストでは file:// の bare リポジトリ */
  cloneBaseUrl?: string;
  intervalMs?: number;
}
/** 1件を最後まで処理する。例外を投げない */
export function runDeployment(deps: DeployerDeps, deployment: Deployment, signal: AbortSignal): Promise<DeployOutcome>;
export interface Deployer { start(): void; wake(): void; stop(): Promise<void> }
export function createDeployer(deps: DeployerDeps): Deployer;
/** 起動時の掃除（research R9）。Worker の recoverOnStartup のあとに呼ぶ */
export function recoverDeployments(deps: DeployerDeps): Promise<{ interrupted: number }>;
/** 起動時の取り直し。例外を投げない */
export function catchUpDeployments(deps: DeployerDeps): Promise<"queued" | "up_to_date" | "disabled" | "error">;
```

`runDeployment` の流れ:

1. ジョブの結び付け（research R3）。ジョブがあれば `merged` → `deploying`・`deploy_started`
2. 取得（`getCloneAccess` → `fetchCommit`）→ 失敗なら `failed(fetch)`
3. ビルド（`build`）→ 失敗なら `failed(build)`
4. 入れ替え（`up`）→ 失敗なら 6 へ（`release`）
5. ヘルスチェック（`waitHealthy`）→ 通れば `succeeded`、イメージの片付け、ジョブ `deployed`、PR の本文。通らなければ 6 へ（`health`）
6. ロールバック（research R7）→ revert PR（research R8）→ `failed(release|health)`、ジョブ `rolled_back`、PR の本文、Issue に報告
7. どの場合も `deploy-<id>` の作業ディレクトリを消す。中断（`signal`）なら `failed(interrupted)`、ジョブは `failJob(stopped)`

## 8. `src/pipeline/ci.ts`

```ts
/** ci_waiting → merged、merged の記録、PR の本文の CI の欄（009 の見回りから切り出す）。移せたら true */
export function markMerged(deps: ReportDeps, job: Job): Promise<boolean>;
```

## 9. `src/main.ts`

- `FactoryServices` に `staging: StagingRuntime` を足す（テストでは偽物）
- 起動: `recoverOnStartup`（007）→ `recoverDeployments` → Worker・見回り・実行器の開始 → 待ち受け → `catchUpDeployments`（待たない）
- 停止: Worker → 見回り → 実行器 → HTTP → 応答のあとの処理 → DB
- 受付に `wakeDeployer` を渡す
