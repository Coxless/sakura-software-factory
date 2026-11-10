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
