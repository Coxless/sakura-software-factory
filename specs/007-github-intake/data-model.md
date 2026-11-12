# Data Model: 受付とジョブキュー（007）

データベースのスキーマ（001）は変えない。

## Job（`jobs`、001）の使い方

| 列 | 007 での値 |
|---|---|
| `repo` | `owner/name`（Webhook の `repository.full_name`） |
| `issue_number` | `issue.number` |
| `trigger_comment_id` | `comment.id`。`(repo, trigger_comment_id)` で一意（重複の配送は `ON CONFLICT DO NOTHING`） |
| `requested_by` | `comment.user.login` |
| `instruction` | 依頼の本文（`@agent` のあと）。`[github] max_instruction_chars` で切り詰める |
| `status` | 遷移の表に従う（下） |
| `branch` | `agent/issue-<issue_number>-job-<id>`（準備で決める） |
| `failure_reason` | 分類（`clone_failed` など。下）と短い説明を `<分類>: <説明>` の形で。秘密情報を伏せる |
| `started_at` / `finished_at` | 取り出した時刻 / `failed` などの終わりの状態になった時刻 |

## 遷移の表（`src/pipeline/state.ts`）

`03` 3章の状態機械。`failed` へはどこからでも（終わりの状態を除く）移れる。

| 現在 | 移ってよい先 |
|---|---|
| `queued` | `planning` |
| `planning` | `implementing` |
| `implementing` | `testing` |
| `testing` | `implementing`、`judging` |
| `judging` | `implementing`（不合格のやり直し）、`pr_opened` |
| `pr_opened` | `ci_waiting` |
| `ci_waiting` | `implementing`（CI 失敗のやり直し）、`merged` |
| `merged` | `deploying` |
| `deploying` | `deployed`、`rolled_back` |
| `deployed`・`rolled_back`・`failed` | なし（終わりの状態） |

- 遷移は `UPDATE ... WHERE id = ? AND status = <現在>` と `job_events`（`type = "state_changed"`、`from_status`・`to_status`）の追加を1つのトランザクションで行う
- 007 が実際に動かすのは `queued`〜`judging` と `failed`
- 起動時の掃除で `failed` にする対象は `planning`・`implementing`・`testing`・`judging`

## 失敗の理由の分類（`FailureKind`）

| 分類 | いつ |
|---|---|
| `clone_failed` | 取得・作業ブランチの作成に失敗 |
| `install_failed` | 依存のインストールに失敗 |
| `pipeline_failed` | 005 の工程が失敗を返した（判定の不合格の上限を含む） |
| `budget_exceeded` | 工程の途中で予算が尽きた |
| `timeout` | ジョブ全体の時間の上限 |
| `shipping_not_available` | 判定に合格したが、出荷の工程（008）がまだない |
| `restarted` | 再起動で中断 |
| `stopped` | 停止の合図で中断 |
| `internal_error` | 想定外の例外 |

## JobEvent（`job_events`、001）の使い方

| `type` | `detail`（JSON） | いつ |
|---|---|---|
| `state_changed` | `{"reason": ...}`（任意） | 遷移のたび |
| `note` | `{"kind": "accepted", "delivery": ...}` | 受付で積んだとき |
| `note` | `{"kind": "report_posted", "comment_url": ...}` | 報告を投稿したとき（二重の投稿の確認に使う） |
| `error` | `{"kind": "report_failed", "message": ...}` | 報告の投稿に失敗したとき |
| `error` | `{"kind": "reaction_failed", ...}` | リアクションに失敗したとき |

## AgentRequest（受付の内部の型。GitHub の型から変換したもの）

| 項目 | 内容 |
|---|---|
| `delivery` | `X-GitHub-Delivery` |
| `repo` | `owner/name` |
| `issueNumber`・`issueTitle`・`issueBody` | Issue |
| `commentId`・`author` | コメントと依頼者 |
| `instruction` | 依頼の本文（切り詰め済み） |

## PipelinePort（005 の入口）

| 入力 | 内容 |
|---|---|
| `jobId` | ジョブの番号（予算ゲートと記録に使う） |
| `workdir` | 取得済み・インストール済みの作業ディレクトリ |
| `issue` | `{ title, body }` |
| `instruction` | 依頼の本文 |
| `signal` | 時間の上限・停止で中断する |
| `onPhase(phase)` | 工程の境目で呼ぶ。007 が状態を進める（`implementing`・`testing`・`judging`） |

| 出力 | 内容 |
|---|---|
| `verdict` | `"pass"` か `"fail"` |
| `summary` | 判定の理由・計画の概要（報告に使う） |
| `failureKind` | 失敗のとき、`pipeline_failed`・`budget_exceeded`・`timeout` のどれか |
