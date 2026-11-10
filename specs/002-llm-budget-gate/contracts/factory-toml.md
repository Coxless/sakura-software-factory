# Contract: `factory.toml` の変更

001 の `specs/001-foundation/contracts/factory-toml.md` に、`[llm]` の省略可能な項目を3つ足す。ほかの表は変えない。

### `[llm]`

| 項目 | 型 | 既定 | 制約 |
|---|---|---|---|
| `provider` | string | `"sakura"` | `sakura` / `google-ai-studio`。`google-ai-studio` は開発用で、`pnpm start` はこの値では起動しない |
| `base_url` | string | — | `https://` で始まる URL（001 から変更なし） |
| `max_attempts` | integer | `3` | 1〜10。最初の1回を含む試行回数の上限 |
| `max_retry_delay_seconds` | integer | `60` | 1〜600。サーバーの待ち時間の指示がこれを超えたら再試行しない |
| `request_timeout_seconds` | integer | `300` | 10〜1800。1回の試行の時間の上限 |

## 環境変数（追加）

| 名前 | 必須 | 説明 |
|---|---|---|
| `SAKURA_AI_API_KEY` | `provider = "sakura"` で LLM を呼ぶとき | さくらのAI Engine の APIキー。設定ファイルには書かない |
| `GEMINI_API_KEY` | `provider = "google-ai-studio"` で LLM を呼ぶとき | Google AI Studio の APIキー（開発用） |

## サンプルの `factory.toml`

- `[llm]` に3項目をコメント付きで書く
- `base_url` とモデル名を、スモークテストで確かめた正しい値に直す（仮の値のコメントを消す）

## 開発用の `factory.dev.toml`

- `[llm] provider = "google-ai-studio"`、`base_url = "https://generativelanguage.googleapis.com/v1beta/openai"`
- モデルは無償枠のもの（実装役 Gemini、検査役 Gemma。原則 III）
- `[storage]` は `data/factory.dev.db`・`data/traces-dev`（さくらの記録と混ぜない）
- `FACTORY_CONFIG=factory.dev.toml` で選ぶ。送るのは公開してよいデータだけ
