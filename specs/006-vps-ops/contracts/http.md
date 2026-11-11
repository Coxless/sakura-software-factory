# Contract: HTTP（006）

## `GET /healthz`（`HEAD` も同じ。本文なし）

| 状態 | ステータス | 本文 | ヘッダー |
|---|---|---|---|
| データベースに `SELECT 1` が通る | `200` | `{"status":"ok"}` | `Content-Type: application/json`、`Cache-Control: no-store` |
| 通らない（例外） | `503` | `{"status":"unhealthy"}` | 同上 |

- 認証なし。LLM を呼ばない。予算を消費しない
- 失敗の理由は `warn` でログに出す（`{ err }`）。本文・ヘッダーには出さない
- 例外でプロセスを落とさない

## 定義していないパス

- `404`、本文 `{"error":"not_found"}`。要求のパスや内部の情報を本文に入れない
- ハンドラーの例外（想定外）は `500`、本文 `{"error":"internal_error"}`。内容は `error` でログに出す

## 停止処理

| きっかけ | 動き | 終了コード |
|---|---|---|
| 1回目の SIGTERM・SIGINT | 新しい接続を止める → 処理中の要求を `[http] shutdown_timeout_seconds` まで待つ → 超えたら残りの接続を切る → データベースを閉じる → `info` "factory stopped" | 0 |
| 停止中の2回目の合図 | 即座に終わる | 130（SIGINT）／143（SIGTERM） |
| 待ち受けに失敗（ポート使用中など） | `fatal` で理由（アドレスとポートを含む）を出す | 1 |

## 起動時のログ

- `info` "factory started" に、待ち受けのアドレス・ポート、データベースの場所、モデル名を含める（001 の項目に `http` を足す）

## 後続の機能が足すもの（本機能では作らない）

- `POST /webhook`（007）、`GET /status`（011）。同じ Hono アプリに足す。Caddy はこの3つのパスだけをファクトリーに転送する（[caddy.md](./caddy.md)）
