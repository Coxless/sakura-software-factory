# Quickstart: 受付とジョブキュー（007）

本機能が動くことを確かめる手順。コマンドは Workshop の中で実行する（`workshop exec dev -- <command>`）。

## 1. 自動テスト（GitHub・LLM なし）

```bash
pnpm run check
```

- `src/github/*.test.ts`: 署名（正しい・ない・別の秘密・書き換え）、依頼の判定（`@agent` の形、引用、コード、ボット、PR、閉じた Issue、編集）、記録したペイロード
- `src/http/webhook.test.ts`: contracts/webhook.md の判定の順と応答のすべて（偽の GitHub）
- `src/pipeline/state.test.ts`: 遷移の表のすべての組（許可・拒否）、記録が1件残ること
- `src/pipeline/worker.test.ts`: ローカルの bare リポジトリ（`file://`）と偽の 005 の入口で、取り出し → 取得 → 作業ブランチ → 入口 → 報告 → 片付け。同時に1件、時間切れ、起動時の掃除、停止。作業ディレクトリの `.git/config` にトークンがないこと
- `src/pipeline/report.test.ts`: 文面、1回だけ、秘密情報の伏せ字、投稿の失敗

## 2. 署名付きの要求を手で送る（ローカル）

```bash
export GITHUB_WEBHOOK_SECRET=local-test-secret GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY_PATH=src/github/fixtures/dummy-key.pem
pnpm start &
body=$(cat src/github/fixtures/issue_comment.created.agent.json)
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -hex | sed 's/^.* //')"
curl -s -X POST http://127.0.0.1:8787/webhook -H "X-GitHub-Event: issue_comment" \
  -H "X-GitHub-Delivery: local-1" -H "X-Hub-Signature-256: $sig" --data-binary "$body"
# → 権限の確認で GitHub に届かないので 500（偽の App ID のため）。署名なしで送ると 401
curl -s -X POST http://127.0.0.1:8787/webhook -H "X-GitHub-Event: issue_comment" --data-binary "$body"
# → {"error":"invalid_signature"}
```

## 3. テスト用のリポジトリで本物の GitHub を確かめる（M2、手で1回）

前提: GitHub App を contracts/github-app.md のとおりに作り、テスト用のリポジトリに入れる。ローカルで受けるには、App の Webhook の URL を一時的に転送の仕組み（例: `gh webhook forward`）に向ける。

| # | 操作 | 期待 |
|---|---|---|
| 1 | 権限のあるアカウントで `@agent README を直して` とコメント | 数秒で `eyes` のリアクション。`jobs` に1行 |
| 2 | 偽の 005 の入口のまま Worker を動かす | Issue に失敗の報告が1回（`shipping_not_available` か入口の結果） |
| 3 | 権限のないアカウントで同じコメント | 何も起きない（ログに `ignored`） |
| 4 | App の「Recent Deliveries」から1の配送を再送 | `duplicate`。ジョブは増えない |

結果は `docs/journal/` に書く。
