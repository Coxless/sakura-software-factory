# Data Model: 基盤（foundation）

1つの SQLite ファイルに5テーブルを置く。共通の決まり:

- 時刻は UTC の Unix ミリ秒（`INTEGER`）。列名は `*_at`
- 主キーは `id INTEGER PRIMARY KEY AUTOINCREMENT`（`budget` だけ `month`）
- 列挙値は `TEXT` に `CHECK` 制約を付け、TS 側でもリテラル型の union にする
- 外部キーは有効（`PRAGMA foreign_keys = ON`）。ジョブを消す運用はしないので `ON DELETE` は既定（制限）のまま

## jobs — `@agent` の依頼1件

| 列 | 型 | NULL | 説明 |
|---|---|---|---|
| id | INTEGER PK | — | |
| repo | TEXT | NOT NULL | `owner/name` |
| issue_number | INTEGER | NOT NULL | |
| trigger_comment_id | INTEGER | NOT NULL | 起点のコメントの ID。Webhook の再送で同じジョブを二重に作らないために使う |
| requested_by | TEXT | NOT NULL | 依頼者の GitHub ログイン名 |
| instruction | TEXT | NOT NULL | 依頼文（`@agent` 以降） |
| status | TEXT | NOT NULL | 下の「状態」。既定 `queued` |
| judge_retries | INTEGER | NOT NULL | 判定で不合格になってやり直した回数。既定 0 |
| ci_retries | INTEGER | NOT NULL | CI 失敗後にやり直した回数。既定 0 |
| branch | TEXT | NULL | 作業ブランチ |
| pr_number | INTEGER | NULL | |
| failure_reason | TEXT | NULL | `failed` のときの理由 |
| created_at | INTEGER | NOT NULL | |
| updated_at | INTEGER | NOT NULL | |
| started_at | INTEGER | NULL | キューから取り出した時刻 |
| finished_at | INTEGER | NULL | 終わりの状態になった時刻 |

- 一意: `(repo, trigger_comment_id)`
- 索引: `(status, created_at)`（キューの取り出し用）

**状態**（FR-015、`03` 3章）: `queued`, `planning`, `implementing`, `testing`, `judging`, `pr_opened`, `ci_waiting`, `merged`, `deploying`, `deployed`, `rolled_back`, `failed`

- 終わりの状態: `deployed`, `rolled_back`, `failed`
- 001 で決めるのは値の範囲だけ。遷移のルールは 007 で `src/pipeline/state.ts` に書く
- 001 で行う遷移は「キューからの取り出し」（`queued` → `planning`、R9）だけ

## job_events — ジョブの出来事の時系列（監査証跡）

| 列 | 型 | NULL | 説明 |
|---|---|---|---|
| id | INTEGER PK | — | 同じジョブ内での順序にも使う |
| job_id | INTEGER FK → jobs.id | NOT NULL | |
| type | TEXT | NOT NULL | `state_changed`, `note`, `error` |
| from_status | TEXT | NULL | `state_changed` のとき |
| to_status | TEXT | NULL | `state_changed` のとき |
| detail | TEXT | NULL | JSON 文字列 |
| created_at | INTEGER | NOT NULL | |

- 索引: `(job_id, id)`
- 時系列の読み出しは `ORDER BY id`（同じミリ秒の出来事でも順序が崩れない）

## llm_calls — LLM 呼び出し1回（リトライは1回ずつ別の行）

| 列 | 型 | NULL | 説明 |
|---|---|---|---|
| id | INTEGER PK | — | |
| job_id | INTEGER FK → jobs.id | NULL | スモークテスト・回帰評価などジョブに属さない呼び出しは NULL |
| phase | TEXT | NOT NULL | 工程（`planning`, `implementing`, `judging`, `smoke`, `eval` など）。工程は今後増えるので CHECK は付けない |
| role | TEXT | NOT NULL | `planner`, `implementer`, `verifier` |
| model | TEXT | NOT NULL | 実際に呼んだモデル名 |
| attempt | INTEGER | NOT NULL | 1 から。リトライのたびに増える |
| input_tokens | INTEGER | NULL | 失敗時などで分からなければ NULL |
| output_tokens | INTEGER | NULL | 同上 |
| latency_ms | INTEGER | NOT NULL | |
| status | TEXT | NOT NULL | `ok`, `error` |
| error | TEXT | NULL | `error` のときの内容（秘密情報はマスク済み） |
| created_at | INTEGER | NOT NULL | 呼び出しの開始時刻。月の集計はこの列で行う |

- 索引: `(created_at)`、`(job_id)`
- CHECK: `attempt >= 1`、`latency_ms >= 0`
- 予算として数えるのは行の数（成功・失敗を問わず、リクエストを送った回数）

**集計**（FR-017、002 が使う）:
- 今月の件数: `SELECT count(*) FROM llm_calls WHERE created_at >= :month_start AND created_at < :next_month_start`。月初はタイムゾーン付きで求める（research R5）
- ジョブの件数: `SELECT count(*) FROM llm_calls WHERE job_id = :job_id`

## deployments — ステージングへのデプロイ1回

| 列 | 型 | NULL | 説明 |
|---|---|---|---|
| id | INTEGER PK | — | |
| job_id | INTEGER FK → jobs.id | NULL | 人間が直接 main に push した場合は NULL |
| commit_sha | TEXT | NOT NULL | |
| image_tag | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | `running`, `succeeded`, `failed` |
| rolled_back | INTEGER | NOT NULL | 0 / 1（Drizzle の boolean モード）。既定 0 |
| rolled_back_to | TEXT | NULL | 戻した先のイメージタグ |
| created_at | INTEGER | NOT NULL | |
| finished_at | INTEGER | NULL | |

- 索引: `(status, created_at)`（「直前に成功したデプロイ」をロールバック先として探す用）

## budget — 月ごとの予算の記録（clarify Q2）

| 列 | 型 | NULL | 説明 |
|---|---|---|---|
| month | TEXT PK | — | `YYYY-MM`（設定のタイムゾーンで決める） |
| monthly_limit | INTEGER | NOT NULL | その月に適用した月の上限（設定値の写し） |
| intake_stopped_at | INTEGER | NULL | 新しいジョブの受付を止めた時刻。止めていなければ NULL |
| created_at | INTEGER | NOT NULL | |

- CHECK: `monthly_limit >= 1`
- 上限の正は `factory.toml`。消費件数は持たず、`llm_calls` から数える
- 行は 002 の予算ゲートがその月の最初の判定のときに作る（001 ではテーブルだけを用意する）

## 関係

```
jobs 1 ──< job_events
jobs 1 ──< llm_calls   (job_id は NULL 可)
jobs 1 ──< deployments (job_id は NULL 可)
budget は独立（month で llm_calls の created_at の範囲と対応する）
```
