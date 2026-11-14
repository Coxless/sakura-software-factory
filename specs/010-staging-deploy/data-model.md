# Data Model: ステージングデプロイ（staging-deploy）

時刻はすべて UTC の Unix ミリ秒（001 の決まり）。

## 1. `deployments`（001 の表を作り直す。マイグレーション `0005_staging_deploy`）

| 列 | 型 | NULL | 説明 |
|---|---|---|---|
| `id` | integer PK | | 積んだ順。取り出しはこの順 |
| `repo` | text | NOT NULL | `owner/name`（新規） |
| `job_id` | integer → `jobs.id` | NULL | 結び付いたジョブ。人間の push・結び付けられなかったときは NULL |
| `commit_sha` | text | NOT NULL | push の `after`（デプロイする commit） |
| `before_sha` | text | NULL | push の `before`。0 だけ・不明（起動時の取り直しで前の記録がない）なら NULL（新規） |
| `image_tag` | text | NOT NULL | `<[staging].image_name>:<commit の先頭 12 文字>`。積むときに決める |
| `status` | text | NOT NULL | `queued`・`running`・`succeeded`・`failed`（`queued` を新規） |
| `failed_stage` | text | NULL | `fetch`・`build`・`release`・`health`・`interrupted`。`failed` のときだけ（新規） |
| `rolled_back` | integer(bool) | NOT NULL, 既定 0 | ステージングを戻した・止めた |
| `rolled_back_to` | text | NULL | 戻し先のイメージ。止めたなら NULL |
| `rollback_healthy` | integer(bool) | NULL | 戻した版のヘルスチェックが通ったか。戻していない・止めたなら NULL（新規） |
| `revert_pr_number` | integer | NULL | 作った revert PR（新規） |
| `error` | text | NULL | 失敗・作らなかった理由・結び付けの失敗など（伏せ字済み、2000 文字まで）（新規） |
| `created_at` | integer | NOT NULL | 積んだ時刻 |
| `started_at` | integer | NULL | `running` にした時刻（新規） |
| `finished_at` | integer | NULL | `succeeded`・`failed` にした時刻 |

**制約**

- 一意: `(repo, commit_sha)`（FR-003。同じ commit は2回積まない）
- CHECK: `status`・`failed_stage` の値、`(status = 'failed') = (failed_stage IS NOT NULL)`、`rolled_back = 0` なら `rolled_back_to IS NULL AND rollback_healthy IS NULL`
- 索引: `(status, id)`（取り出し）、`job_id`

**状態の移り変わり**

```
queued ──(取り出し)──▶ running ──▶ succeeded
                          └──────▶ failed（failed_stage: fetch / build / release / health / interrupted）
```

- `queued` → `running`: `claimNextDeployment`（即時トランザクションの1文。`started_at` を入れる）
- `running` → `succeeded` / `failed`: `finishDeployment`（`status = 'running'` の条件付きの更新。`finished_at` を入れる）
- 起動時: `running` → `failed`（`interrupted`）
- `release`・`health` の失敗だけがロールバックする（`rolled_back = 1`）

**集計の例**（SC-006）

```sql
-- デプロイの成功率とロールバックの回数
SELECT count(*) FILTER (WHERE status = 'succeeded') * 1.0 / count(*) AS success_rate,
       count(*) FILTER (WHERE rolled_back) AS rollbacks
FROM deployments WHERE status IN ('succeeded', 'failed');
```

## 2. `jobs`（列は変えない）

010 で使う遷移（007 の `pipeline/state.ts` の表に既にある）:

```
ci_waiting ──(PR のマージ。009 の見回り、または 010 の実行器)──▶ merged
merged ──(デプロイを始める)──▶ deploying
deploying ──(ヘルスチェックが通った)──▶ deployed
deploying ──(ロールバックした)──▶ rolled_back
deploying ──(取得・ビルドの失敗 / 中断)──▶ failed（deploy_failed / restarted / stopped）
```

- `deployed`・`rolled_back`・`failed` は終わりの状態（`finished_at` を入れる）
- `merged` のまま push の知らせが来ないジョブ（取りこぼし）は、起動時の取り直しで既定のブランチの先頭がそのマージ commit なら進む。それより前のマージは `merged` のまま残る（記録で見える）

## 3. `job_events`（`type = 'note'` / `'error'` の `detail.kind` を足す）

| kind | type | detail | 書くとき |
|---|---|---|---|
| `deploy_started` | note | `{ deployment_id, commit_sha, image_tag }` | `merged` → `deploying` と同時 |
| `deploy_result` | note | `{ deployment_id, status, failed_stage, rolled_back, rolled_back_to, rollback_healthy }` | デプロイが終わったとき |
| `revert_pr` | note | `{ deployment_id, pr_number, url }` | revert PR を作ったとき |
| `revert_skipped` | note | `{ deployment_id, reason }` | revert PR を作らなかったとき |
| `deploy_body_failed` | error | `{ message }` | PR の本文のデプロイの欄を書けなかったとき |
| `report_posted` | note | `{ comment_url }` | ロールバックの報告を Issue に投稿したとき（007 と同じ。二重の投稿を防ぐ） |
| `report_failed` | error | `{ message }` | 投稿できなかったとき |

`state_changed` の `detail` には `{ deployment_id }`（`deploying`・`deployed`・`rolled_back`）を入れる。

## 4. 失敗の分類（`pipeline/report.ts` の `FAILURE_KINDS`）

- `deploy_failed`（新規）: 「ステージングへのデプロイ（取得・ビルド）に失敗しました。ステージングは前の版のままです」
- `restarted`・`stopped`（007）: `deploying` で中断したときにも使う

`failJob` は、失敗する前の状態が `merged`・`deploying` のジョブでは PR を Draft に変えない（マージ済み）。

## 5. 設定 `[staging]`

[contracts/factory-toml.md](./contracts/factory-toml.md) を参照。

## 6. 型（GitHub 層の外に見せるもの、`github/port.ts`）

```ts
/** Webhook から取り出した push の知らせ */
interface PushEvent {
  repo: string;            // owner/name
  ref: string;             // refs/heads/main など
  defaultBranch: string;
  before: string;          // 0 だけならブランチの作成
  after: string;
  deleted: boolean;
}
```

## 7. 型（`deploy/`）

```ts
type DeployStage = "fetch" | "build" | "release" | "health" | "interrupted";

interface HealthResult {
  healthy: boolean;
  attempts: number;
  /** 最後の応答の状態コード、または接続のエラー */
  last: string;
}

/** 1件のデプロイの結果（runner の戻り値・テスト用） */
type DeployOutcome =
  | { kind: "succeeded" }
  | { kind: "failed"; stage: "fetch" | "build" | "interrupted" }
  | { kind: "rolled_back"; stage: "release" | "health"; to: string | null; healthy: boolean | null; revertPr: number | null };
```
