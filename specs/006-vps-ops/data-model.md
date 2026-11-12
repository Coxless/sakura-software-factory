# Data Model: VPS配備と秘密情報スキャン（006）

データベースのスキーマは変えない。本機能で増えるのは設定・応答・VPS 上のファイルの形。

## HttpConfig（`factory.toml` の `[http]`）

| 項目 | 型 | 既定 | 検証 |
|---|---|---|---|
| `host` | 文字列 | `"127.0.0.1"` | 空でない。ループバック（`127.0.0.0/8`・`::1`・`localhost`）以外なら起動時に `warn` |
| `port` | 整数 | `8787` | 1〜65535 |
| `shutdown_timeout_seconds` | 整数 | `10` | 1〜60 |

- セクションごと省略できる（すべて既定値）。知らない項目は 001 と同じく検証エラー
- 詳細: [contracts/factory-toml.md](./contracts/factory-toml.md)

## HealthStatus（`/healthz` の応答）

| 状態 | HTTP | 本文 |
|---|---|---|
| 正常 | `200` | `{"status":"ok"}` |
| 不健康 | `503` | `{"status":"unhealthy"}` |

- 判定はデータベースへの `SELECT 1` だけ。失敗の理由はログ（`warn`）に出し、本文には出さない

## ServerHandle（`src/http/server.ts` が返すもの）

| 項目 | 内容 |
|---|---|
| `address` | 実際に待ち受けているアドレスとポート（テストでポート 0 を使うため） |
| `close()` | 新しい接続を止め、処理中の要求を `shutdown_timeout_seconds` まで待ち、超えたら残りを切って終わる。何度呼んでもよい |

状態の移り変わり: `listening` → `closing`（1回目の合図）→ `closed`。`closing` 中に2回目の合図が来たら即座に終了する。

## VPS 上の配置（DeployLayout）

| パス | 所有・権限 | 中身 | 更新で |
|---|---|---|---|
| `/opt/node-v24.22.2`・`/opt/node` | root | Node.js（`/opt/node` はリンク） | 版を上げたときだけ変わる |
| `/opt/sakura-factory/app` | root | リポジトリの checkout（`node_modules` を含む） | 指定のコミットに変わる |
| `/etc/sakura-factory/factory.toml` | root、`0644` | 設定。初回だけ作る | 変えない |
| `/etc/sakura-factory/factory.env` | `root:factory`、`0640` | 秘密情報（運用者が書く） | 変えない |
| `/etc/caddy/Caddyfile` | root | `deploy/Caddyfile` の写し | 毎回写す |
| `/etc/caddy/caddy.env` | `root:caddy`、`0640` | ドメイン・TLS（運用者が書く） | 変えない |
| `/var/lib/sakura-factory` | `factory`、`0750` | DB・軌跡・作業ディレクトリ（007） | 変えない |
| `/etc/systemd/system/factory.service` | root | `deploy/systemd/factory.service` の写し | 毎回写す |

詳細: [contracts/deploy.md](./contracts/deploy.md)

## GitleaksPin（`scripts/install-gitleaks.sh` の定数）

| 項目 | 内容 |
|---|---|
| `GITLEAKS_VERSION` | `8.30.1` |
| `GITLEAKS_SHA256_linux_x64` | 公式の `checksums.txt` から写す |
| `GITLEAKS_SHA256_linux_arm64` | 同上 |

## GitleaksAllowlist（`.gitleaks.toml`）

| 項目 | 内容 |
|---|---|
| `[extend] useDefault` | `true`（既定の規則をすべて使う） |
| `[[allowlists]]` | 1件ごとに `description`（理由）・`paths`（ファイル1つ）・`regexes`（その偽の値だけ）。`condition = "AND"` で両方を満たすときだけ許可する |
