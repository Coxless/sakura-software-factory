# Data Model: LLM層と予算ゲート（llm-budget-gate）

001 で作った記録先を使う。変更は `llm_calls` への列の追加1つだけ（research R10）。

## llm_calls（変更あり）

試行1回が1件。本機能のゲートが唯一の書き手。

| 列 | 型 | NULL | 本機能での入れ方 |
|---|---|---|---|
| `id` | integer PK | — | 自動 |
| `job_id` | integer → jobs.id | 可 | 呼び出しの文脈のジョブ。スモークテスト・回帰評価は NULL |
| `phase` | text | 不可 | 呼び出しの文脈の工程（`plan` / `implement` / `judge` / `smoke` など。CHECK なし） |
| `role` | text | 不可 | `planner` / `implementer` / `verifier` |
| `model` | text | 不可 | 実際に送ったモデル名（`factory.toml` の値） |
| `attempt` | integer ≥ 1 | 不可 | ゲート内の試行回数（1始まり）。予算切れで送らなかった試行は記録しない |
| `input_tokens` | integer | 可 | 応答の usage。取れなければ NULL |
| `output_tokens` | integer | 可 | 同上 |
| `latency_ms` | integer ≥ 0 | 不可 | 試行の開始から終わり（最後のイベント、または失敗）まで |
| `status` | `ok` / `error` | 不可 | 成功なら `ok`。`aborted`・`timeout` も `error` |
| `error_kind` | text | 可 | **追加**。`transient` / `permanent` / `timeout` / `aborted`。`ok` なら NULL。CHECK で値を限る |
| `error` | text | 可 | マスク済みのエラー文（HTTP の状態コードがあれば先頭に付ける。例 `429 Too Many Requests: ...`）。`ok` なら NULL |
| `created_at` | integer | 不可 | 試行の開始時刻（UTC ミリ秒）。月の集計はこの列 |

**整合のルール**
- `status = 'ok'` ⇔ `error_kind IS NULL`（CHECK）
- 1回の呼び出しの試行は `attempt` が 1, 2, … と連続し、成功が出たらそれが最後
- 記録は試行の終わりに1回の INSERT で書く（途中の状態を残さない）

**マイグレーション**: `drizzle-kit generate` で `ALTER TABLE llm_calls ADD error_kind text` と CHECK を足す。SQLite は既存の表に CHECK を足せないため、drizzle-kit が表を作り直す SQL を出す場合はそれをそのまま使う（既存の行は、`status = 'ok'` なら `error_kind = NULL`、`status = 'error'` なら `error_kind = 'permanent'` で移す。001 には書き手がないので通常は0行だが、CHECK に反する行でマイグレーションが止まらないようにする）。

## budget（変更なし・使い方だけ追加）

- ゲートは呼び出し前に、その月の行を `INSERT ... ON CONFLICT(month) DO NOTHING` で用意する（`monthly_limit` は設定値の写し、`created_at` は今）
- 判断には設定値を使い、この表の `monthly_limit` は使わない
- `intake_stopped_at` は 007 が書く

## 呼び出しの文脈（CallContext、メモリ上のみ）

| 項目 | 型 | 説明 |
|---|---|---|
| `jobId` | number \| null | ジョブ。null ならジョブの上限を見ない |
| `phase` | string | 工程 |
| `role` | `LlmRole` | 役割。モデル名の解決にも使う |

## 予算切れ（BudgetExceededError、メモリ上のみ）

| 項目 | 型 | 説明 |
|---|---|---|
| `scope` | `"monthly"` / `"job"` | どちらの上限か |
| `limit` | number | 上限値 |
| `used` | number | 消費件数 |

ストリームの `errorMessage` では `budget_exceeded:<scope> limit=<n> used=<n>` の形で運ぶ（research R9）。

## 試行の結果（AttemptOutcome、メモリ上のみ）

| 項目 | 型 | 説明 |
|---|---|---|
| `ok` | boolean | 成功か |
| `kind` | `transient` / `permanent` / `timeout` / `aborted` | 失敗の種類 |
| `httpStatus` | number \| undefined | 捕まえた HTTP の状態コード |
| `retryAfterMs` | number \| undefined | サーバーの待ち時間の指示 |
| `usage` | `{ input, output }` \| undefined | トークン数 |
| `message` | string \| undefined | マスク前のエラー文（記録時にマスク） |

## スモークテストの結果（SmokeReport、メモリ上・出力のみ）

| 項目 | 型 | 説明 |
|---|---|---|
| `model` | string | 対象のモデル名 |
| `mode` | `"pi"` / `"raw"` / `"raw-nostream"` | 経路（`raw` はストリーミング、`raw-nostream` は `stream: false`） |
| `compat` | object | 使った互換フラグ（`pi` のときだけ） |
| `checks` | `{ id: "a".."f", name, passed, detail? }[]` | 確認項目ごとの合否。不合格なら `detail` にマスク済みのモデル出力 |
| `requests` | number | 送ったリクエスト数（`llm_calls` に記録した件数と一致） |
| `passed` | boolean | すべて合格か |
