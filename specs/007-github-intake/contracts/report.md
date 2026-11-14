# Contract: Issue へのコメントの文面（007）

本文はすべて `maskSecrets`（001）を通してから投稿する。ファクトリーのコメントは日本語で書く。

## 失敗の報告（1ジョブに1回）

```markdown
### 🏭 ファクトリー: ジョブ #<id> は完了しませんでした

| 項目 | 内容 |
|---|---|
| 止まった工程 | <失敗したときの状態。例: implementing>。準備（Issue・リポジトリの取得、インストール）で止まったときは「準備」（状態は `planning` のままだが、計画役の失敗と取り違えないようにする） |
| 理由 | <分類の説明>（`<分類>`） |
| 消費したリクエスト | <件数> / 1ジョブの上限 <per_job_requests> |
| 作業ブランチ | `<branch>`（push していません）。作る前に止まったときは「なし」 |
| やり直し・変更 | <retries> 回 / <files> ファイル（+<insertions> −<deletions>）。005 の工程まで進まなかったときは行ごと省く |

<詳細（任意。説明・判定の理由。2000 文字で切り詰める）>
```

| 分類 | 説明の文 |
|---|---|
| `clone_failed` | Issue またはリポジトリを取得できませんでした |
| `install_failed` | 依存のインストールに失敗しました |
| `pipeline_failed` | 計画から判定までの工程が失敗しました |
| `judge_rejected` | やり直しの上限（<judge_retries> 回）まで、判定に合格しませんでした |
| `budget_exceeded` | リクエストの予算に達しました |
| `timeout` | ジョブの時間の上限（<job_timeout_minutes> 分）を超えました |
| `shipping_not_available` | 判定には合格しましたが、PR を作る工程はまだありません（008 で消した。008 の [report.md](../../008-ship-and-report/contracts/report.md)） |
| `restarted` | ファクトリーの再起動で中断しました |
| `stopped` | ファクトリーの停止で中断しました |
| `internal_error` | 内部エラーが起きました |

- 詳細は分類ごとに次を入れる（research R2）: `shipping_not_available` は判定の理由（`verdict.reasons`）、`judge_rejected` は最後の不合格の理由（`reason`）、`pipeline_failed`・`budget_exceeded` は `error`（なければ `reason`）、`install_failed` は標準エラーの末尾

## 使い方（依頼の本文が空のとき）

```markdown
🏭 ファクトリーへの依頼は、コメントの1行目を `@agent` で始め、続けてやってほしいことを書いてください。

例:
@agent README のインストール手順に pnpm の場合を足してください
```

## 予算切れ（断った依頼1件ごとに1回）

```markdown
🏭 今月のリクエストの予算の残り（<remaining>）が、1ジョブの上限（<per_job_requests>）を下回っているため、この依頼は受け付けませんでした。来月（<timezone> の月初）に改めて依頼してください。
```
