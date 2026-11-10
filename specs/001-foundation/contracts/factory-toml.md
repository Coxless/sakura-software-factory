# Contract: `factory.toml`

運用者が書く設定ファイルの形。TypeBox のスキーマ（`src/config.ts`）がこの表の正となる。

- すべての表（table）で未知の項目はエラーになる
- 「既定」がない項目は必須
- 秘密情報（APIキー・トークン・秘密鍵）はここに書かない。環境変数で渡す（下の「環境変数」）
- 場所は環境変数 `FACTORY_CONFIG`、なければ `./factory.toml`

## 項目

### `[llm]`

| 項目 | 型 | 既定 | 制約 |
|---|---|---|---|
| `base_url` | string | — | `https://` で始まる URL |
| `max_attempts` | integer | `3` | 1〜10。最初の1回を含む LLM 呼び出しの試行回数の上限（002 で追加） |
| `max_retry_delay_seconds` | integer | `60` | 1〜600。サーバーの待ち時間の指示がこれを超えたら再試行しない（002 で追加） |
| `request_timeout_seconds` | integer | `300` | 10〜1800。1回の試行の時間の上限（002 で追加） |

### `[models]`

| 項目 | 型 | 既定 | 説明 |
|---|---|---|---|
| `planner` | string | — | 計画役 |
| `implementer` | string | — | 実装役（Kimi 系） |
| `verifier` | string | — | 検査役（Qwen / Gemma 系） |
| `verifier_alt` | string | なし（省略可） | 検査役の比較用（012） |
| `fallback` | string | — | プレビューモデル停止時の退避先（gpt-oss-120b） |

すべて1文字以上。モデル名には既定値を持たせない（原則 I: モデル名をコードに書かない）。

### `[budget]`

| 項目 | 型 | 既定 | 制約 |
|---|---|---|---|
| `monthly_requests` | integer | — | ≥ 1 |
| `per_job_requests` | integer | — | ≥ 1、かつ ≤ `monthly_requests` |
| `timezone` | string | `"Asia/Tokyo"` | IANA のタイムゾーン名 |

### `[limits]`

| 項目 | 型 | 既定 | 制約 |
|---|---|---|---|
| `judge_retries` | integer | 2 | ≥ 0。判定不合格のやり直しの上限 |
| `ci_retries` | integer | 2 | ≥ 0。CI 失敗後のやり直しの上限 |
| `max_turns_per_phase` | integer | 40 | ≥ 1。1工程のターン数の上限 |
| `job_timeout_minutes` | integer | 60 | ≥ 1。ジョブ全体の時間 |
| `ci_wait_timeout_minutes` | integer | 30 | ≥ 1。CI 待ちの時間 |

### `[auto_merge]`

| 項目 | 型 | 既定 | 制約 |
|---|---|---|---|
| `max_diff_lines` | integer | 300 | ≥ 1 |
| `forbidden_paths` | string[] | `[".github/workflows/**", ".env*", "**/pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock", "deploy/**"]` | glob |
| `allowed_work_types` | string[] | `["bugfix", "test", "docs", "refactor"]` | 1件以上 |

### `[github]`

| 項目 | 型 | 既定 | 制約 |
|---|---|---|---|
| `allowed_users` | string[] | — | 1件以上。`@agent` を実行できるユーザー（書き込み権限の確認に加えて絞る） |

### `[storage]`

| 項目 | 型 | 既定 |
|---|---|---|
| `database_path` | string | `"data/factory.db"` |
| `trace_dir` | string | `"data/traces"` |

相対パスは設定ファイルのあるディレクトリを基準に解決する。

### `[log]`

| 項目 | 型 | 既定 | 制約 |
|---|---|---|---|
| `level` | string | `"info"` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` のどれか |

## 例（必須項目だけ）

```toml
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"

[models]
planner = "Kimi-K2.7-Code"
implementer = "Kimi-K2.7-Code"
verifier = "Qwen3.6"
fallback = "gpt-oss-120b"

[budget]
monthly_requests = 3000
per_job_requests = 100

[github]
allowed_users = ["Coxless"]
```

URL とモデル名は仮の値。002 のスモークテストで実機の正しい値に直す。

## 検証エラーの形

すべての問題を集めて、1つのエラーで報告する。1件ごとの形:

```
<パス>: <理由>
```

例:

```
factory.toml の検証に失敗しました（3件）
  /models/implementer: 必須の項目がありません
  /budget/per_job_requests: monthly_requests（3000）以下にしてください（現在 5000）
  /llm/api_key: 未知の項目です。秘密情報は設定ファイルに書かず、環境変数で渡してください
```

TOML の構文エラーのときは、行と列を含むメッセージにする。

## 環境変数

| 名前 | 用途 | 使い始める機能 |
|---|---|---|
| `FACTORY_CONFIG` | 設定ファイルの場所（任意） | 001 |
| `SAKURA_AI_API_KEY` | さくらのAI Engine の APIキー | 002 |
| GitHub App の ID・秘密鍵・Webhook シークレット | GitHub 連携 | 007（名前は 007 で決める） |

秘密情報は `requireEnv(name)` で読み、なければ名前を含むエラーで止める。
