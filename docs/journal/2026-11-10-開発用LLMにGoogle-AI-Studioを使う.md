# 開発用の LLM に Google AI Studio を使う

## やろうとしたこと

さくらの月3,000リクエストを AI解禁まで使わずに、004・005 のハーネスを実際の LLM で作り込みたい。

## 調べたこと

- **GitHub Models**: 2026-07-30 に提供を終了していた。docs.github.com のページには「As of July 30, 2026, GitHub Models has been fully retired. The playground, model catalog, inference API, and bring your own key (BYOK) are no longer available to any customer.」とだけある。`https://models.github.ai/catalog/models` は 200 を返すが、本文は `OK` だけでモデルの一覧は返らなかった。終了前の記事にあった無償枠の上限（1日50〜150リクエスト、1リクエスト入力8K・出力4K）は、もう使えない
- **Google AI Studio（Gemini API）**（2026-11-10 に aistudio.google.com/docs で確認）
  - OpenAI 互換: `https://generativelanguage.googleapis.com/v1beta/openai/`、`Authorization: Bearer`、ストリーミングと `tools` に対応。OpenAI 互換は「still in beta」。`stream_options.include_usage` は、サンプルにあるだけで対応表には載っていない（実際に確かめる）
  - 無償のモデル: `gemini-3.8-flash`・`gemini-3.6-flash`・`gemini-3.5-flash-lite` など。Gemma 4 も無償だが、モデル ID は料金のページに載っていない
  - 上限はプロジェクト単位で、1日の上限は太平洋時間の0時に戻る。具体的な数値は AI Studio の画面にしかなく、まだ確かめていない
  - 無償枠のデータの扱い: 「Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services and machine learning technologies」「human reviewers may read, annotate, and process your API input and output」「Do not submit sensitive, confidential, or personal information to the Unpaid Services」
  - 日本は利用できる地域に入っている

## 決めたこと

- constitution を 1.2.0 に改定し、原則 I に開発中の例外を足した。常駐するファクトリーでは使わない。送るのは公開してよいデータだけ（このリポジトリは公開）。記録は別のデータベースにする
- `[llm].provider`（`sakura` / `google-ai-studio`）を足した。APIキーの環境変数は提供元で決まる（`SAKURA_AI_API_KEY` / `GEMINI_API_KEY`）。予算ゲート・記録・再試行・スモークテストは同じコードのまま動く
- `factory.dev.toml` を足し、`FACTORY_CONFIG` で切り替えるようにした。DB は `data/factory.dev.db` なので、さくらの月の消費に数えない
- `pnpm start` は `provider` が `sakura` 以外なら起動しない（`assertProductionProvider`）。実際に `FACTORY_CONFIG=factory.dev.toml pnpm start` が次のメッセージで exit 1 になることを確かめた

  ```
  Error: [llm].provider = "google-ai-studio" は開発用です。常駐するファクトリーは provider = "sakura" でだけ起動します（constitution 原則 I）
  ```

- 開発中の実装役は Gemini、検査役は Gemma 4 にした。原則 III の別系統を開発中も守るため
- 記事では「本番の推論は さくらで閉じる。開発中は公開データだけを Gemini で試した」と書く

## 比べた選択肢

- ローカルの LLM（Ollama など）: データが PC の外に出ないので原則 I の趣旨に最も近い。ただし手元の GPU 次第で、`base_url` の `https://` の制約も外す必要がある。ユーザーの判断で Google AI Studio にした
- 有料枠の Gemini: 学習に使われないが、無料枠の中でという方針から外れる

## まだ分かっていないこと

- Gemma 4 の正確なモデル ID（`factory.dev.toml` は仮に `gemma-4`）
- 無償枠の1日の上限の数値
- Gemini の OpenAI 互換で、ストリーミングの usage が返るか、`developer` ロールや `max_tokens` を受け付けるか（スモークテストで確かめる。T042）

## 初めての実行（T042）で分かったこと

### `gemini-3.8-flash` が応答を返さない

`FACTORY_CONFIG=factory.dev.toml pnpm run smoke:llm` を実行すると、最初の要求が 300 秒で時間切れになった。予算ゲートは次の1件を記録した。

```
model: gemini-3.8-flash, attempt: 1, status: error, error_kind: timeout, latency_ms: 300023
error: Request aborted (cause: The operation was aborted due to timeout)
```

そこで、Node から最小の要求（「pong とだけ答えてください。」、`stream: false`）を直接送って切り分けた。

| モデル | 結果 |
|---|---|
| `gemini-3.8-flash` | 60 秒でも 240 秒でも、応答のヘッダーすら返らない |
| `gemini-3.5-flash-lite` | 200。7,949 ms で `pong`。usage は prompt 8 / completion 1 |
| `gemini-2.5-flash-lite` | 404。328 ms で返る: `This model models/gemini-2.5-flash-lite is no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite ...` |
| `gemini-3.6-flash` | 計測の出力を取りこぼした（未確認） |

- APIキーなしで送ると、400 が 164 ms で返る。つまり接続そのものは問題ない
- `GET /v1beta/openai/models`（推論なし）は 170 ms で返る。一覧に `gemini-3.8-flash` はある。Gemma 4 の ID は `gemma-4-26b-a4b-it` と `gemma-4-31b-it`
- 応答の `message.extra_content.google.thought_signature` に、思考の署名が入っている。Gemini 3 系はツール呼び出しの往復でこの署名を返す必要がある可能性がある。Pi の openai-completions がこれを保持するかは、まだ確かめていない

### Workshop の中では IPv6 で外に出られない

```
$ curl -6 https://generativelanguage.googleapis.com/v1beta/openai/models
curl: (7) Failed to connect to generativelanguage.googleapis.com port 443 after 8179 ms: Couldn't connect to server
$ curl -4 ...   → 404 in 0.077s
```

`getent hosts` は IPv6 のアドレスだけを返す。Node の fetch は IPv4 にフォールバックするので、今回の時間切れの原因ではなかった。

### 失敗: APIキーを会話のログに出してしまった

ホストの環境変数を Workshop に渡すために、`workshop exec dev -- env GEMINI_API_KEY="$GEMINI_API_KEY" ...` と、APIキーをコマンドの引数で渡していた。そのあと止まらない処理を調べるために `pgrep -af` を実行し、プロセスの引数に入っていたキーの値をそのまま表示してしまった。キーは作り直す必要がある。

今後は、キーを引数に置かず標準入力で渡す。

```bash
printf %s "$GEMINI_API_KEY" | workshop exec dev -- bash -lc 'read -r GEMINI_API_KEY; export GEMINI_API_KEY; cd /project && ...'
```

あわせて、`pgrep -f` が自分自身のコマンドにも一致して、待ちのループが終わらない失敗もした。

## キーを作り直したあとの実行

`factory.dev.toml` を次のように直した。

- 実装役・計画役: `gemini-3.5-flash-lite`
- 検査役: `gemma-4-26b-a4b-it`
- 退避先: `gemini-3.6-flash`
- `request_timeout_seconds`: 120

APIキーは標準入力で Workshop に渡した。

### 素の HTTP は、ツールの結果を返したところで 400 になった

```
LLM 呼び出しに失敗しました: 400 [{"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:get_weather` , position 2. ...","status":"INVALID_ARGUMENT"}}]
requests: 3
```

Gemini 3 系は、ツール呼び出しの `extra_content.google.thought_signature` を、次の要求の assistant の `tool_calls` にそのまま付けて返す必要がある。

Pi 1.5.0 の openai-completions も、この項目を保持しない（`api/openai-completions.js` に `extra_content` の扱いがない）。そのため Pi 経由でも同じ 400 になるはずだった。

対応: ゲートの `createGatedStreamFn` で、Pi の `onProviderStreamEvent` が渡す生のチャンクからツール呼び出しの id ごとに `extra_content` を覚え、`onPayload` で次の要求の `tool_calls` に戻すようにした。素の HTTP の経路でも同じように送り返す。どの提供元でも同じ動きになるようにしてあり、さくらはこの項目を返さないので影響しない。偽の LLM に `extraContent` を仕込めるようにして、3つの経路それぞれで、3つ目の要求に `extra_content` が載ることをテストした。

### 結果（Gemini は全部合格）

| コマンド | 結果 | リクエスト数 |
|---|---|---|
| `smoke:llm --raw` | 6項目すべて PASS | 3 |
| `smoke:llm`（Pi 経由） | 6項目すべて PASS | 3 |
| `smoke:llm --raw --no-stream` | 6項目すべて PASS | 3 |
| `smoke:llm --role verifier`（`gemma-4-26b-a4b-it`） | 実行中に失敗（exit 2）。下の表 | 7 |

`data/factory.dev.db` の `llm_calls`（実装役は `gemini-3.5-flash-lite`）:

| 経路 | 要求 | 所要時間 | 入力 / 出力トークン |
|---|---|---|---|
| raw | 1 / 2 / 3 | 1,667 / 1,186 / 692 ms | 28/1, 95/16, 130/9 |
| pi | 1 / 2 / 3 | 2,111 / 9,224 / 5,585 ms | 28/1, 95/16, 130/10 |
| raw-nostream | 1 / 2 / 3 | 8,903 / 5,882 / 1,388 ms | 28/1, 95/16, 130/8 |

- ストリーミングでも usage は返った（`stream_options.include_usage` は効く）
- `developer` ロールなし・`max_tokens` の互換フラグのままで通った
- 所要時間は 0.7〜9.2 秒と、ばらつきが大きい

### Gemma 4 は 500 が多い

```
11 verifier gemma-4-26b-a4b-it 1 error transient   1097ms
12 verifier gemma-4-26b-a4b-it 2 error transient    878ms
13 verifier gemma-4-26b-a4b-it 3 ok                3644ms  28/1
14 verifier gemma-4-26b-a4b-it 1 ok                2130ms  95/16
15〜17 verifier gemma-4-26b-a4b-it 1〜3 error transient（ツールの結果を返す要求で 500 が3回）
LLM 呼び出しに失敗しました: 500 [{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}]
```

ゲートの再試行（最大3回）と、試行ごとの記録は想定どおりに動いた。実機で初めて確かめられたことになる。

検査役は本番ではツールなしの1回呼び出し（原則 III）なので、ツールの往復で 500 になる問題は、検査役の役割には直接は関わらない。最初の要求でも2回 500 が出たので、開発中の検査役として安定して使えるかは 005 で確かめる。

### まだ分かっていないこと

- `gemini-3.8-flash` が応答を返さない理由（無償枠での混雑か、思考に時間がかかるのか）
- Gemma 4 の 500 が一時的なものか、ツールの往復（`extra_content` を付けた履歴）に起因するのか
