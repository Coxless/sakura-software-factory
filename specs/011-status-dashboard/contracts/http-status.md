# Contract: GET /status

ファクトリー本体（`127.0.0.1:8787`）の応答。外からは Caddy の Basic 認証を通ったものだけが届く（[caddy.md](./caddy.md)）。

## 要求

| 要求 | 応答 |
|---|---|
| `GET /status` | `200`、HTML（`text/html; charset=UTF-8`） |
| `GET /status?format=json` | `200`、JSON（`application/json`）。形は [data-model.md](../data-model.md) の StatusSnapshot |
| `GET /status?format=<その他>` | `200`、HTML |
| `HEAD /status` | `200`、本文なし（Hono の GET と同じ扱い） |
| `POST` など | `404`（`{"error":"not_found"}`。ほかのパスと同じ） |
| DB が読めない | `500`、`{"error":"internal_error"}`。原因はログ（`status failed`）だけ |

## 見出し（200・500 とも）

| 見出し | 値 |
|---|---|
| `Cache-Control` | `no-store` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `X-Frame-Options` | `DENY` |
| `Content-Security-Policy` | `default-src 'none'; style-src 'sha256-<CSS のハッシュ>'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` |

## HTML

- 1ページ。スクリプト・外部の読み込み・フォームなし。CSS は `<style>` 1つ（CSP のハッシュと一致させる）
- 上から: 今月（月・タイムゾーン・計算した時刻）→ 5つの数値（消費・成功率・平均処理時間・CI 初回通過率・デプロイ成功率）→ 消費の内訳 → 失敗の理由 → 最近のジョブ → 最近の工程の実行 → 最近のデプロイ
- 率は `60.0%（6/10）`、分母 0 は `データなし`。時間は `1時間2分3秒` のような形。時刻は月と同じタイムゾーンで `YYYY-MM-DD HH:mm`
- 処理時間の注記: 「Draft PR は人間がマージするまで待つので長くなる」
- 受付を止めているときは、上部に「予算で新しいジョブの受付を止めています（<時刻>）」
- 記録から取り出した文字列はすべてエスケープする

## 出さないもの（HTML・JSON とも）

`jobs.instruction`、`jobs.failure_reason` の種類より後ろ、`jobs.requested_by`、`agent_runs.error`・`trace_path`、`deployments.error`・`image_tag`・`rolled_back_to`、`llm_calls.error`、設定ファイルのパス、環境変数の値

## 副作用

なし。LLM を呼ばず、DB に書かない（予算を使わない）
