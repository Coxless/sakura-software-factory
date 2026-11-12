# Contract: `POST /webhook`（007）

006 の Caddyfile が `/webhook` をファクトリーに転送する。

## 入力

| ヘッダー | 使い方 |
|---|---|
| `X-Hub-Signature-256` | `sha256=<hex>`。生の本文に対する HMAC-SHA256（秘密は `GITHUB_WEBHOOK_SECRET`）。定数時間で比べる |
| `X-GitHub-Event` | `issue_comment` だけを処理する。`ping` は応答だけ |
| `X-GitHub-Delivery` | 配送の ID。ログと `job_events` に残す |

本文の上限は `[github] webhook_max_body_kb`（既定 1024）。

## 判定の順と応答

| # | 確認 | 満たさないとき |
|---|---|---|
| 1 | 本文が上限以下 | `413 {"error":"payload_too_large"}` |
| 2 | 署名がある・正しい | `401 {"error":"invalid_signature"}`（本文を解釈しない） |
| 3 | JSON として正しい | `400 {"error":"invalid_payload"}` |
| 4 | `ping` | `200 {"result":"pong"}` |
| 5 | `issue_comment` で `action == "created"`、Issue（PR でない）、開いている、ボットでない | `202 {"result":"ignored"}` |
| 6 | 最初の空でない行が `@agent`（単語として） | `202 {"result":"ignored"}` |
| 7 | 依頼者が書き込み以上の権限を持ち、`allowed_users` に含まれる | `202 {"result":"ignored"}`（Issue に書かない。`info` のログ） |
| — | 権限の確認ができない（API の失敗・5 秒の時間切れ） | `500 {"error":"internal_error"}`（`error` のログに配送の ID） |
| 8 | 依頼の本文が空でない | `202 {"result":"usage"}`、応答のあと Issue に使い方を書く |
| 9 | 月の予算の残り ≥ 1ジョブの上限 | `202 {"result":"budget_exhausted"}`、受付を止めた時刻を記録、応答のあと Issue に知らせる |
| 10 | 積む（`(repo, trigger_comment_id)` が既にあれば積まない） | 新しく積んだら `202 {"result":"queued","job":<id>}`、既にあれば `202 {"result":"duplicate","job":<id>}` |
| — | DB に書けない | `500 {"error":"internal_error"}` |

- 新しく積んだときだけ、応答のあとで依頼のコメントに `eyes` のリアクションを付け、Worker の待ちを打ち切る
- 応答の本文に、内部の情報（例外の文、パス、設定値）を含めない
- GitHub は失敗した配送を自動では再送しない。`500` のときは、運用者が App の設定画面の「Advanced → Recent Deliveries」から再送する（手順書に書く）

## 依頼の形

```
@agent <依頼の本文の1行目>
<続く行も本文に含める>
```

- `@agent` の直後は空白か行末。`@agentx`・`@agent-bot` は依頼ではない
- 最初の空でない行が `@agent` で始まらなければ依頼ではない（引用 `> @agent`、コードブロックの中、文中の言及を含む）
- 本文は `[github] max_instruction_chars`（既定 20000）で切り詰める
