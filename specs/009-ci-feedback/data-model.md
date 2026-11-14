# Data Model: CI連携（009）

## 1. `jobs` に足す列（マイグレーション `0004_ci_feedback`）

| 列 | 型 | 内容 | 書く場所 |
|---|---|---|---|
| `base_sha` | TEXT NULL | 最初の出荷のときの基準の commit（clone した既定のブランチの先頭） | 最初の出荷（`judging` → `ci_waiting` と同じトランザクション） |
| `head_sha` | TEXT NULL | ファクトリーが最後に push した commit | 出荷・やり直しの出荷 |
| `ci_status` | TEXT NULL（`pending`・`passed`・`failed`） | CI の結論。`failed` は「やり直しを待つ」 | 出荷（`pending`）、見回り（`passed`・`failed`）、取り出し（NULL） |
| `ci_deadline` | INTEGER NULL | CI 待ちの期限（UTC ミリ秒）= push の時刻 ＋ `ci_wait_timeout_minutes` | 出荷・やり直しの出荷 |
| `ci_event_at` | INTEGER NULL | 知らせを受けた印（見回りで評価する） | 受付・起動時（入れる）、見回り（消す） |

- CHECK: `ci_status IN ('pending', 'passed', 'failed')`（NULL は通る）
- 索引: `jobs_status_ci_status_idx(status, ci_status)`
- `ci_retries`（001 の列）は、やり直しを取り出すたびに1増やす

### 状態と CI の列の組み合わせ

| `status` | `ci_status` | 意味 | 次 |
|---|---|---|---|
| `ci_waiting` | `pending` | CI の結論を待つ | 見回りが `passed`・`failed`・`failed` の状態（時間切れ・上限）に |
| `ci_waiting` | `passed` | CI 通過。マージを待つ（時間切れなし） | マージの知らせで `merged`、閉じられたら `failed` |
| `ci_waiting` | `failed` | やり直しを待つ | Worker が取り出して `implementing`（`ci_status` は NULL） |
| `implementing`〜`judging` | NULL | やり直しの工程 | 合格で `pr_opened` → `ci_waiting`（`pending`） |

## 2. 状態の遷移（007 の表のまま。009 で使う遷移）

```text
judging(合格) → pr_opened → ci_waiting           # 008 の出荷。009 では CI の列も書く
ci_waiting → implementing                         # やり直しの取り出し（ci_retries + 1）
implementing → testing → judging → pr_opened → ci_waiting   # やり直しの合格と push
ci_waiting → merged                               # PR がマージされた
ci_waiting → failed                               # ci_failed・ci_timeout・pr_closed
implementing〜judging → failed                    # やり直しの工程の失敗（005・007 の分類）、ci_unfixed
```

## 3. `job_events` に足す記録（`type = 'note'` / `'error'`、`detail` の `kind`）

| `kind` | type | detail | 書く場所 |
|---|---|---|---|
| `ci_event` | note | `{ event: "check_suite" \| "pull_request", delivery, head_sha?, action }` | 受付 |
| `ci_result` | note | `{ head_sha, conclusion: "success" \| "failure", failed: [{ name, conclusion }], attempt }`（`attempt` = その commit が何回目の CI か = `ci_retries + 1`） | 見回り（条件付きの更新が1行を変えたときだけ） |
| `ci_retry_pushed` | note | `{ head_sha, ci_retry, decision, unmet }` | やり直しの出荷 |
| `ci_gave_up` | note | `{ reason: FailureKind, converted_to_draft: boolean }` | `failJob` の引き渡し |
| `merged` | note | `{ pr_number }`（遷移の `state_changed` とは別に、CI の欄に出すため） | 見回り |
| `ci_body_failed` | error | `{ message }` | 見回り（PR の本文の更新の失敗） |
| `handover_failed` | error | `{ message }` | `failJob` の引き渡しの失敗 |
| `shipped`（008） | note | 008 の項目に `plan`（計画役の JSON か null）・`plan_text` を足す | 出荷・やり直しの出荷 |

### 集計の例（SC-008）

- CI 初回通過: `ci_result` のうち `attempt = 1` の `conclusion`
- やり直しの回数: `jobs.ci_retries`
- 最後の結論: ジョブごとの最新の `ci_result`、または `jobs.status`・`failure_reason`

## 4. 失敗の分類（`FailureKind` に足す）

| 分類 | 意味 | 報告に書くもの |
|---|---|---|
| `ci_failed` | CI が失敗し、やり直しの上限（`ci_retries`）に達した | PR、やり直しの回数、失敗したチェックの名前 |
| `ci_timeout` | CI 待ちの期限を過ぎても結論が出ない | PR、待った時間 |
| `ci_unfixed` | やり直しで前回の push からの変更がなかった | PR、やり直しの回数 |
| `pr_closed` | マージされずに PR が閉じられた（やり直しの push の前の確認を含む） | PR |

## 5. GitHub 層の型（`src/github/port.ts`）

```ts
interface PullRequestState {
  number: number;
  url: string;
  nodeId: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  autoMerge: boolean;
  headSha: string;
  body: string;
}

interface CheckRunInfo {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  /** チェックを作った App の slug（github-actions など） */
  app: string | null;
}

/** Webhook から取り出した CI の知らせ */
type CiEvent =
  | { kind: "check_suite"; repo: string; headBranch: string | null; headSha: string }
  | { kind: "pull_request_closed"; repo: string; prNumber: number; merged: boolean };
```

## 6. 005 の入口の追加（`PipelineInput`）

| 項目 | 内容 |
|---|---|
| `planObject?: Plan` | `plan`（文章）と一緒に渡すと、計画役を呼ばずに結果の `plan` に入れる |
| `baseCommit?: string` | diff の基準。省くと HEAD（005 のまま） |
| `initialFeedback?: Feedback[]` | 1回目の実装工程の最初の入力に入れる（2回目以降は 005 の不合格のフィードバック） |
| `preflightChecks?: boolean` | 1回目の実装工程の前に工程内テストを回し、結果を `initialFeedback` に足す |
