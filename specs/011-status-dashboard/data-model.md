# Data Model: 計測と状況ページ（status-dashboard）

新しい表・列はない。要求のたびに記録から計算し、保存しない。JSON のスキーマは `src/status/schema.ts`（TypeBox）を正とする。時刻は UTC の Unix ミリ秒。

## StatusSnapshot

| フィールド | 型 | 説明 |
|---|---|---|
| `generated_at` | number | 計算した時刻 |
| `month` | `{ key: "YYYY-MM", start, end, time_zone }` | 集計した月（`monthRange`、`[budget].timezone`） |
| `consumption` | Consumption | 今月の LLM の消費 |
| `jobs` | JobStats | 成功率・処理時間 |
| `ci` | `{ first_pass: Rate }` | CI 初回通過率 |
| `deployments` | DeployStats | デプロイ成功率 |
| `recent` | `{ jobs: JobRow[], runs: RunRow[], deployments: DeployRow[] }` | 最近の一覧（新しい順） |

## Rate

| フィールド | 型 | 説明 |
|---|---|---|
| `numerator` | integer ≥ 0 | |
| `denominator` | integer ≥ 0 | |
| `ratio` | number (0〜1) \| null | 分母 0 なら null（表示は「データなし」） |

## Consumption

| フィールド | 型 | 元 |
|---|---|---|
| `requests` | integer | 今月の `llm_calls` の件数（`created_at` が月の範囲。予算ゲートの `countLlmCallsInMonth` と同じ） |
| `monthly_limit` | integer | `[budget].monthly_requests` |
| `remaining` | integer | `max(0, monthly_limit - requests)` |
| `intake_stopped_at` | number \| null | 今月の `budget.intake_stopped_at` |
| `by_role` | `{ key, count }[]` | `role` ごと（件数の多い順） |
| `by_model` | `{ key, count }[]` | `model` ごと |
| `job_requests` / `non_job_requests` | integer | `job_id` があるもの／NULL のもの |
| `input_tokens` / `output_tokens` | integer | 合計（NULL は 0） |
| `errors_by_kind` | `{ key, count }[]` | `status = 'error'` の `error_kind` ごと |

## JobStats

| フィールド | 型 | 元 |
|---|---|---|
| `success` | Rate | `finished_at` が今月で終わりの状態のジョブ。分子は `deployed` |
| `by_status` | `{ key, count }[]` | 同じ分母の状態ごと |
| `failures_by_reason` | `{ key, count }[]` | 同じ分母のうち `failure_reason` があるもの。`key` は種類（research R5） |
| `duration_ms` | `{ count, mean: number \| null, median: number \| null }` | `started_at` と `finished_at` があるものの `finished_at - started_at` |
| `in_progress` | integer | 終わりの状態でないジョブの件数（月に関係なく今） |

## DeployStats

| フィールド | 型 | 元 |
|---|---|---|
| `success` | Rate | `finished_at` が今月で `succeeded`・`failed` のデプロイ。分子は `succeeded` |
| `rolled_back` | integer | 同じ分母のうち `rolled_back = 1` |

## 一覧の行（出す列だけ）

**JobRow**: `id, repo, issue_number, pr_number, status, failure_kind, created_at, started_at, finished_at, duration_ms, requests`

- 出さない: `instruction`・`failure_reason` の文・`requested_by`・`trigger_comment_id`・`branch`・SHA

**RunRow**: `id, job_id, phase, attempt, model, outcome, turns, requests, tool_calls, blocked_calls, compactions, verdict, started_at, finished_at, duration_ms`

- `outcome` が NULL なら実行中
- 出さない: `error`・`trace_path`・`steers`（運用者向けの数ではないので省く）

**DeployRow**: `id, repo, job_id, commit (先頭 12 文字), status, failed_stage, rolled_back, revert_pr_number, created_at, finished_at, duration_ms`

- 出さない: `error`・`image_tag`・`rolled_back_to`・`before_sha`

## 決まり

- 一覧の件数: ジョブ 20・工程の実行 30・デプロイ 10（research R8）
- `duration_ms` は両方の時刻があるときだけ数値、なければ null
- `key` のある内訳は件数の多い順、同数なら `key` の順
