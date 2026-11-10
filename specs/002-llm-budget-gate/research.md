# Research: LLM層と予算ゲート（llm-budget-gate）

調査は 2026-11-08 に、Workshop `dev` の中で `@earendil-works/pi-ai@1.5.0` と `@earendil-works/pi-agent-core@1.5.0` を一時ディレクトリに入れ、README と `dist/*.d.ts`・`dist/*.js` を読んで行った。

## R1. Pi のバージョン

**Decision**: `@earendil-works/pi-ai` と `@earendil-works/pi-agent-core` を **1.5.0** で完全に固定する（`^` なし）。`pi-schema` は pi-ai の依存として同じ 1.5.0 が入る。

**Rationale**:
- 1.x の最新（2026-11-02 公開）。001 の research R1 で TypeBox 1.x を選んだ根拠が `pi-schema` 1.5.0 で、同じ版にそろう
- 3つを同じ版で出す方針（`03` 5章）どおり、pi-agent-core も 1.5.0 がある
- 004 で pi-agent-core を本格的に使うが、`StreamFn` の型を 002 で使うため今入れる

**Alternatives considered**: 1.4.0（2026-10-21）に留める → 不採用。TypeBox の前提の版がずれる。1.5.0 で問題が出たら 1.4.0 に下げる。

## R2. さくらのAI Engine を提供元として登録する方法

**Decision**: `createProvider({ id: "sakura", auth: { apiKey: envApiKeyAuth("さくらのAI Engine", ["SAKURA_AI_API_KEY"]) }, models, api: openAICompletionsApi() })` で作り、`createModels()` に `setProvider()` する。モデルは `factory.toml` の `[models]` の値から `Model<"openai-completions">` を組み立てる（`id` にモデル名、`baseUrl` に `[llm].base_url`）。

- 旧 API（`registerApiProvider` など、`@earendil-works/pi-ai/compat`）は「将来削除」と明記されているので使わない
- `contextWindow` と `maxTokens` は モデル定義に必須。さくらの公開値が分からないため、`src/llm/provider.ts` の定数（`contextWindow: 131072`, `maxTokens: 8192`）で始め、スモークテストで分かったら直す。料金は無償枠なので `cost` はすべて 0
- APIキーの環境変数名は `SAKURA_AI_API_KEY`。001 の `requireEnv` と同じく、なければ名前を含むエラーにする（スモークテストは LLM を呼ぶ前に確かめる）

**Rationale**: README の「Custom Providers」の推奨経路。`compat` をモデル単位に持てるので、モデルごとの差（`03` 6章）を吸収できる。

## R3. 互換フラグ（compat）の初期値

**Decision**: すべてのさくらのモデルに次の `compat` を付けて始め、スモークテストで確かめて直す。

| フラグ | 初期値 | 理由 |
|---|---|---|
| `supportsDeveloperRole` | `false` | 互換サーバーの多くは `developer` ロールを知らない。`system` で送る |
| `supportsReasoningEffort` | `false` | `reasoning_effort` を無視または拒否する可能性。推論の強さは使わない |
| `supportsStore` | `false` | `store` は OpenAI 本家の項目 |
| `supportsUsageInStreaming` | `true` | トークン数の記録（FR-015）に要る。返らなければ確認項目 (f) が不合格になり、`false` に変えて非ストリーミングでの取得を検討する |
| `supportsStrictMode` | `false` | `strict` のツール定義は OpenAI 本家の機能 |
| `maxTokensField` | `"max_tokens"` | `max_completion_tokens` を知らない互換サーバーが多い |

フラグはスモークテストの引数（`--compat key=value`）で一時的に上書きでき、決まった値を `src/llm/provider.ts` の定数に書く（`factory.toml` には置かない。エンドポイントの性質で、運用者が触る値ではないため）。

**Alternatives considered**: `compat` を省いて URL による自動判定に任せる → 不採用。さくらは自動判定の対象外で、OpenAI 本家の既定（`developer` ロール、`max_completion_tokens`）で送られてしまう。

## R4. 予算ゲートの差し込み位置

**Decision**: pi-agent-core の `StreamFn`（`(model, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream | Promise<...>`）の形で、ゲート付きの関数を `createGatedStreamFn(deps, callContext)` で作る。中では `models.streamSimple()` を呼ぶ。計画役・検査役（ツールなしの1回呼び出し、005）も同じ関数を直接呼ぶ。

- `setDefaultStreamFn()` に「ゲートを通さずに呼ばれたら例外を投げる関数」を設定し、Agent に `streamFn` を渡し忘れても素通りしないようにする（SC-007）
- 呼び出しの文脈（ジョブ・工程・役割）は `createGatedStreamFn` の引数で束ねる。Agent 1つにつき1つ作る

**Rationale**: `03` 1章の方針どおり、LLM を呼ぶ関数を丸ごと差し替える。`StreamFn` の形にそろえておけば、004 の Agent にそのまま渡せる。

## R5. リトライを Pi の内部ではなくゲートで行う

**Decision**: 内側の呼び出しには常に `maxRetries: 0` を渡し、リトライはゲートだけで行う。

**調べて分かったこと**:
- openai-completions の実装は OpenAI SDK を `maxRetries: 0` で呼び、自前の `retryProviderRequest()` で包んでいる。その `maxRetries` の既定は **0**（`options.maxRetries ?? 0`）。つまり既定では Pi は再試行しないが、呼び出し元（pi-agent-core など）が `maxRetries` を渡すと内部で再試行され、ゲートから見えない
- 型のコメントには「OpenAI SDK の既定は 2」とあり、紛らわしい。明示的に 0 を渡して上書きする
- Pi の再試行対象の判定（408・409・429・5xx・ステータスなし、`x-should-retry` ヘッダー優先、`retry-after-ms`／`retry-after` を尊重、指数バックオフ 0.5s→8s 上限、待ち時間の上限 60 秒）は SDK と同じ方針。ゲートの判定もこれに合わせる

**Rationale**: 原則 V（リトライはゲートの層で漏れなく数える）。

## R6. 失敗の種類の判定と HTTP の状態の取り方

**Decision**: ゲートが内側の呼び出しに **自前の `fetch`**（`StreamOptions.fetch`）を渡し、HTTP の応答の状態コードとヘッダー（`retry-after-ms`・`retry-after`・`x-should-retry`）を試行ごとに捕まえる。判定は次のとおり。

| 状況 | 種類 | 再試行 |
|---|---|---|
| 予算が足りない | `budget_exceeded`（記録しない） | しない |
| 呼び出し元の `signal` が中止された | `aborted` | しない |
| ゲートの時間の上限（既定5分）を超えた | `timeout` | する |
| `x-should-retry: true` | `transient` | する |
| `x-should-retry: false` | `permanent` | しない |
| 408・409・429・5xx | `transient` | する（待ち時間の指示があれば従う。上限超えなら `permanent` にして止める） |
| その他の 4xx（401・403・404・422 など） | `permanent` | しない |
| HTTP の応答がない（接続失敗・DNS） | `transient` | する |
| 200 のあと、応答の途中でエラー | 通信系のエラー文（`terminated`・`ECONNRESET`・`socket`・`network`・`timeout` を含む）なら `transient`、それ以外（ツール呼び出しの解析失敗など）は `permanent` | 種類による |
| 記録（DB への書き込み）の失敗 | 呼び出し元へは失敗として返す | しない |

`retry-after` が `max_retry_delay_seconds` を超えた 429 を `permanent` にするのは、このゲートの中ではもう再試行しない（待ち続けると工程の時間の上限を食い潰す）ことを表すため。`error` 列の先頭には状態コード（`429`）が残るので、集計では認証失敗などの 4xx と状態コードで分けられる。

**調べて分かったこと**: Pi は失敗を例外にせず、ストリームの `error` イベントと `stopReason: "error" | "aborted"`、`errorMessage`（文字列）で返す。状態コードは構造化された形では残らない（`formatProviderError` で文字列にされる）。`onResponse` は成功したときしか呼ばれない。そのため状態コードは `fetch` を差し替えて取る。

**Alternatives considered**: `errorMessage` の文字列から状態コードを正規表現で拾う → 不採用。書式が版で変わりうる。

## R7. 途中までの応答を呼び出し元に渡さない方法

**Decision**: ゲートは内側のストリームのイベントを最後（`done` か `error`）まで溜めてから、成功なら溜めたイベントを外側のストリームに順に流し、`result()` も同じメッセージで解決する。失敗して再試行するなら溜めた分を捨てる。最終的に失敗したら、`error` イベント1つ（`stopReason: "error"` か `"aborted"`、`errorMessage` にマスク済みの理由）を流す。

**Rationale**: FR-013。リアルタイムに文字を表示する画面はないので、ストリーミングの逐次性を失っても困らない。予算切れも同じく `error` イベントで返し、メッセージの先頭で区別できるようにする（R9）。

**Alternatives considered**: 逐次流しつつ、失敗したら外側に「やり直し」を伝える → 不採用。pi-agent-core はやり直しの合図を知らず、途中のテキストが軌跡に残ってしまう。

## R8. 時間の上限

**Decision**: 試行ごとに `deps.timeoutSignal(request_timeout_seconds * 1000)`（既定は `AbortSignal.timeout`）と呼び出し元の `signal` を `AbortSignal.any()` で合わせて内側に渡す。中止されたとき、呼び出し元の `signal` が中止済みなら `aborted`、そうでなければ `timeout` と判定する。`timeoutMs` も同じ値を渡す（Pi の説明では、接続後のストリームの無通信時間にも使われる）。

時間の上限の signal を作る関数は `GateDeps.timeoutSignal` として注入できるようにする。設定の `request_timeout_seconds` は最小10秒なので、本物のタイマーのままではタイムアウトのテストに10秒以上かかり SC-006 を満たせない。テストでは手動で中止できる signal を渡し、`timeout` の判定を即座に確かめる。

## R9. 予算切れの返し方

**Decision**: `StreamFn` の契約（失敗は例外ではなくストリームの `error`）に従い、予算切れは LLM を呼ばずに `error` イベントで返す。`errorMessage` は `budget_exceeded:monthly limit=3000 used=3000` の形（機械で読める接頭辞）。あわせて、ゲートを直接使う呼び出し元（005 の計画役・検査役、スモークテスト）のために、最終メッセージから `BudgetExceededError` を取り出す関数 `getBudgetExceeded(message)` を用意する。

**Rationale**: pi-agent-core の Agent はストリームの `error` を受けるとループを止めて終わる。呼び出し元（007 の状態機械）は `getBudgetExceeded` で予算切れかどうかを見て `failed` に遷移する。

## R10. 記録（llm_calls）の列の追加

**Decision**: `llm_calls` に `error_kind`（`transient` / `permanent` / `timeout` / `aborted`、成功なら NULL、CHECK 付き）を足すマイグレーションを作る。`error` 列にはマスク済みのエラー文を入れる。

**Rationale**: FR-016 の「失敗の種類」を、記事用の SQL 集計（種類ごとの件数）でそのまま使える。エラー文の接頭辞に埋め込む方法より集計が楽。

**マスク**: `maskSecrets()`（001）に加え、そのとき使っている APIキーの値そのものを `[REDACTED]` に置き換える。さくらの APIキーの形は分からないため、形のパターンだけに頼らない。

## R11. 予算（budget）テーブルの扱い

**Decision**: ゲートは呼び出し前に、その月（設定のタイムゾーン）の行を `INSERT ... ON CONFLICT DO NOTHING` で用意する（`monthly_limit` に設定値を写す）。判断には常に設定値を使い、テーブルの値は使わない（001 の決定どおり、上限の正は設定ファイル）。

## R12. 受付の可否

**Decision**: `canAcceptNewJob(db, config, now)` は `monthly_requests − 今月の消費 >= per_job_requests` なら `true`。理由（残り件数）も返す。

## R13. 偽の LLM（テスト用）

**Decision**: OpenAI互換の応答を返す **偽の `fetch`** を作り、ゲートの `fetch` に注入する。本物の さくらの提供元（`createSakuraModels`）と openai-completions のアダプターはそのまま使い、ネットワークの手前だけを差し替える。

- 偽の `fetch` は、仕込んだ応答を順に返す: テキスト・ツール呼び出し（SSE の `chat.completion.chunk` 列と、最後の usage）、HTTP エラー（状態コード・`retry-after` ヘッダー・本文）、接続失敗（`fetch` が `TypeError` を投げる）、途中で切れる応答（SSE を数行流してから本文のストリームをエラーにする）
- 受け取った要求の本文（`model`・`messages`・`tools`）を記録し、テストから確かめられる
- 仕込みが尽きたら `fake LLM: no more responses` の 500 ではなく、`fetch` 自体が例外を投げてテストの失敗と分かるようにする
- 素の HTTP の経路（スモークテストの `--raw`）は既定でストリーミング、`--no-stream` で非ストリーミングの JSON 応答を受けるので、偽の `fetch` は要求の `stream` の有無で SSE と JSON を出し分ける

**Rationale**: 状態コードやヘッダーによる再試行の判定（R6）、途中で切れたときの扱い（R7）、usage の取り出し（`supportsUsageInStreaming`）を、本物のアダプターを通して確かめられる。004 以降のテストも同じ偽物でツール呼び出しを仕込める。

**Alternatives considered**: pi-ai の `fauxProvider()` → 不採用。応答の形は本物と同じだが、HTTP の状態コード・ヘッダー・接続失敗を表せず、ゲートの再試行の判定をテストできない。受け取った入力の記録もない。

## R14. 素の HTTP でのスモークテスト

**Decision**: スモークテストに `--raw` を付けると、Pi を通さずに Node の `fetch` で `POST {base_url}/chat/completions` を送る（Pi 経由と同じく `stream: true` と `stream_options: { include_usage: true }`、`tools` は OpenAI 形式の JSON Schema、`tool_choice` は送らない）。SSE は自前で読み、`delta.tool_calls` を `index` ごとにつなげて引数の JSON を組み立てる。`--no-stream` を付けると `stream: false` で送り、JSON の応答から読む。この経路もゲートの中核（予算の確認・試行の記録・リトライ）を通す。ゲートの中核は「1回の試行を行う関数」を受け取る形にし、`StreamFn` 用と素の HTTP 用の2つの試行関数から使う。

**Rationale**: clarify の決定（素の HTTP で切り分けてから切り替える）と、原則 V（ゲートを迂回しない）の両立。素の HTTP も既定でストリーミングにするのは、Pi 経由と同じ要求にするため。非ストリーミングで比べると、ツール呼び出しの分割や usage のチャンクといったストリーミング特有の問題が Pi の問題なのか さくらの問題なのかを区別できず、FR-026 の切り替えの判断を誤る。`--raw --no-stream` は、さくらのストリーミング自体を疑うときの追加の切り分けに使う。

## R15. スモークテストの確認項目の作り方

**Decision**: 1回の実行で次の3〜4リクエストを送る（上限10件）。

1. ツールなし: 「`pong` とだけ答えて」→ (a) テキストが返る、(f) トークン数が取れる
2. ツールあり（`get_weather(city: string)` の1つ）: 「東京の天気を調べて」→ (b) `get_weather` のツール呼び出しが構造化されて返る、(c) 引数が TypeBox のスキーマ（`Value.Check`）に合う、(e) 本文に `<tool_call>`・`<|tool_call` などの記法がない
3. 2 の続きにツールの結果（`{"weather":"晴れ"}`）を返す → (d) テキストの応答が返り、(e) 同様に漏れがない

結果は標準出力に表で出し、`--json` で JSON でも出せるようにする（journal に貼るため）。

## R16. 設定の追加

**Decision**: `factory.toml` の `[llm]` に省略可能な項目を3つ足す。

| 項目 | 既定 | 制約 |
|---|---|---|
| `max_attempts` | 3 | 1〜10（最初の1回を含む） |
| `max_retry_delay_seconds` | 60 | 1〜600 |
| `request_timeout_seconds` | 300 | 10〜1800 |

APIキーの環境変数名は設定にしない（`SAKURA_AI_API_KEY` に固定）。
