# 002 llm-budget-gate の spec と plan

## やろうとしたこと

実装計画の 002 `llm-budget-gate`（さくらを Pi の提供元として登録し、予算ゲート・リトライ・記録を `streamFn` の層に置く。実機でツール呼び出しを確かめる）を、Spec Kit で specify → clarify → plan まで進める。ブランチは 001 と同じく手で `git checkout -b 002-llm-budget-gate` で作った。

## clarify で決めたこと（3問）

| 問い | 決定 | 理由 |
|---|---|---|
| プレビューモデルが提供終了して「存在しないモデル」が返ったら、退避先（gpt-oss-120b）へ自動で切り替えるか | 切り替えない。恒久的なエラーで失敗させ、運用者が `factory.toml` を直す | 実装役も検査役も同じ gpt-oss になると「実装と検査を別モデルにする」（原則 III）が黙って崩れる。記録も単純になる |
| スモークテストで不合格が出たら、何を基準に Pi → TanStack AI に切り替えるか | 互換フラグを変えて再確認 → 素の HTTP でも同じ要求を送って比べる → 素の HTTP は通るのに Pi 経由で通らないときだけ切り替える | 不合格の原因がモデル側（さくら側）なら、ライブラリを替えても直らない。切り替えの無駄打ちを避ける |
| 失敗したリクエストも月の消費に数えるか | 送った全件を数える | さくらが失敗を無償枠に数えるかは分からない。多めに数える側に倒しておけば枠を超えない |

## Pi 1.5.0 を読んで分かったこと

調べ方: Workshop の中で一時ディレクトリに `pnpm add @earendil-works/pi-ai@1.5.0 @earendil-works/pi-agent-core@1.5.0` を入れ、README と `dist/` を読んだ。

- **独自の提供元は `createProvider()` ＋ `createModels().setProvider()` で作る。** 旧 API（`registerApiProvider` など）は `@earendil-works/pi-ai/compat` に移されていて、「将来削除」と書かれている。古い記事の書き方は使えない
- **互換フラグは `compat` でモデルごとに持てる。** `supportsDeveloperRole` / `supportsReasoningEffort` / `supportsUsageInStreaming` / `maxTokensField` など。`compat` がないと URL で自動判定するが、さくらは判定の対象外なので、OpenAI 本家の既定（`developer` ロール、`max_completion_tokens`）で送られてしまう
- **Pi の内部リトライの既定は 0 回。** openai-completions のアダプターは OpenAI SDK を `maxRetries: 0` で呼び、自前の `retryProviderRequest()` で包んでいる。その既定は `options.maxRetries ?? 0`。ただし型のコメントには「OpenAI SDK の既定は 2」とあって紛らわしい。呼び出し元（pi-agent-core など）が `maxRetries` を渡すとゲートから見えない再試行が起きるので、ゲートから常に `maxRetries: 0` を渡すことにした
- **失敗は例外にならず、HTTP の状態コードも残らない。** 失敗はストリームの `error` イベントと `stopReason: "error"`、`errorMessage`（文字列）で返る。状態コードは `formatProviderError` で文字列に埋め込まれるだけ。`onResponse` は成功したときしか呼ばれない。429 と 401 を区別して再試行を決めたいので、`StreamOptions.fetch` に自前の `fetch` を渡して状態コードと `retry-after` を捕まえることにした
- **pi-agent-core の `StreamFn` の形は `(model, context: TranscriptContext, options?) => AssistantMessageEventStream | Promise<...>`。** `setDefaultStreamFn()` という「streamFn を渡し忘れたときの既定」がある。ここに「呼ばれたら例外」を入れておけば、ゲートを通らない呼び出しを塞げる
- **テスト用の `fauxProvider()` がある**（応答のキュー、`fauxToolCall` など）。ただし HTTP の状態コード・ヘッダー・接続失敗を表せないので、ゲートの再試行の判定はテストできない。そこで「OpenAI互換の SSE を返す偽の `fetch`」を自前で作り、本物のアダプターを通したままネットワークの手前だけ差し替える方針にした

## まだ分かっていないこと

- さくらのAI Engine の正確な `base_url` とモデル名（`factory.toml` は仮の値のまま）
- `stream_options.include_usage` でトークン数が返るか
- Kimi-K2.7-Code のツール呼び出しが構造化されて返るか、本文に漏れるか（スモークテストで確かめる）
- 各モデルの `contextWindow` / `maxTokens` の公開値
