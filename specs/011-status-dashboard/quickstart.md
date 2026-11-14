# Quickstart: 計測と状況ページ（status-dashboard）

## 1. 自動テスト

```bash
workshop exec dev -- bash -lc 'cd /project && pnpm run check'
```

- `src/status/collect.test.ts`: 用意した記録で、5つの数値・内訳・一覧が期待どおり（今月と先月の切り分け、分母 0、実行中の工程）
- `src/http/app.test.ts`: `/status` の HTML と JSON、見出し、目印の文字列（依頼の本文・エラー文・軌跡の場所）が応答に出ないこと、DB が読めないときの 500

## 2. ローカルで見る

常駐のファクトリー（`pnpm start`）は さくら の設定と GitHub App の秘密情報がないと起動しないので、ローカルでは同じ集計を CLI で出す。

```bash
# 開発用の DB（factory.dev.toml の [storage].database_path）を読む。書き込まない
workshop exec dev -- bash -lc 'cd /project && pnpm run status:dev' | jq '.consumption, .jobs.success'
workshop exec dev -- bash -lc 'cd /project && pnpm run status:dev -- --html' > /tmp/status.html
```

- 期待: JSON の `consumption.requests` が、同じ月の範囲（JSON の `month.start`・`month.end`）で `llm_calls` を数えた値と一致する。HTML をブラウザで開くと5つの数値が並ぶ

```bash
workshop exec dev -- bash -lc 'cd /project && node -e "const D=require(\"better-sqlite3\");const d=new D(\"data/factory.dev.db\",{readonly:true});console.log(d.prepare(\"select count(*) c from llm_calls where created_at >= ? and created_at < ?\").get(<start>, <end>))"'
```

- 開発用の DB のマイグレーションが古いと `no such column` で止まり、`db:migrate` を示す。`FACTORY_CONFIG=factory.dev.toml pnpm run db:migrate` を流してから実行する

## 3. 配備物の検査

```bash
workshop exec dev -- bash -lc 'cd /project && pnpm run deploy:lint'
workshop exec dev -- bash -lc 'cd /project && pnpm run deploy:rehearsal'
```

- `deploy:lint`: `caddy validate` が通る
- `deploy:rehearsal`: 「`/status` は認証なしで 401」「正しい認証で 200」「誤ったパスワードで 401」が ok

## 4. 本番（VPS解禁のあと）

`deploy/README.md` の「状況ページ」の節に従ってハッシュを作り、`/etc/caddy/caddy.env` に書いて `setup.sh` を流す。ブラウザで `https://<FACTORY_DOMAIN>/status` を開くと認証を求められ、通ると数値が出る。
