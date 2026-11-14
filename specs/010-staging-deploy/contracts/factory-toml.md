# Contract: `factory.toml` の追加分（010）

001 の [factory-toml.md](../../001-foundation/contracts/factory-toml.md) に足す。

```toml
[staging]
# ステージングデプロイ（010）。repo が空ならデプロイしない（push の知らせはすべて無視）
repo = "Coxless/factory-sandbox"   # main への push をデプロイするリポジトリ（owner/name）
project = "sakura-staging"         # docker compose のプロジェクト名
image_name = "sakura-staging-app"  # イメージの名前（タグは commit の先頭 12 文字）
port = 3100                        # 127.0.0.1 に公開するポート（deploy/Caddyfile の転送先と合わせる）
health_path = "/healthz"           # ヘルスチェックのパス
health_timeout_seconds = 60        # ヘルスチェックの全体の上限
health_interval_seconds = 2        # ヘルスチェックの間隔
health_successes = 3               # 続けて 200 が返る回数
build_timeout_seconds = 600        # 取得とビルドの時間の上限
keep_images = 5                    # 残しておく成功したイメージの数
public_url = ""                    # PR の本文に書くステージングの URL（例: https://staging.example.jp）。空なら書かない
```

| 項目 | 型 | 既定 | 範囲・形 |
|---|---|---|---|
| `staging.repo` | 文字列 | `""` | 空、または `owner/name` |
| `staging.project` | 文字列 | `sakura-staging` | `^[a-z0-9][a-z0-9_-]*$`（compose のプロジェクト名の決まり） |
| `staging.image_name` | 文字列 | `sakura-staging-app` | `^[a-z0-9][a-z0-9._/-]*$`（タグを含まない） |
| `staging.port` | 整数 | 3100 | 1024〜65535 |
| `staging.health_path` | 文字列 | `/healthz` | `/` で始まる |
| `staging.health_timeout_seconds` | 整数 | 60 | 5〜600 |
| `staging.health_interval_seconds` | 整数 | 2 | 1〜60 |
| `staging.health_successes` | 整数 | 3 | 1〜20 |
| `staging.build_timeout_seconds` | 整数 | 600 | 30〜3600 |
| `staging.keep_images` | 整数 | 5 | 2〜50 |
| `staging.public_url` | 文字列 | `""` | 空、または `http://`・`https://` で始まる |

- `[staging]` の節を省いたときは、すべて既定（`repo` が空なのでデプロイしない）
- 範囲の外の値・形の違う値・未知の項目では起動しない（項目の名前を含むエラー。001 の `ConfigError`）
- compose の定義（`deploy/staging/compose.yaml`）の場所は設定にしない（ファクトリーのコードの一部。research R13）
- ポートは 006 の `deploy/Caddyfile` の転送先（`127.0.0.1:3100`）と合わせる。ヘルスチェックは `http://127.0.0.1:<port><health_path>` に送る
