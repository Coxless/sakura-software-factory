# 2026-11-28 さくらのAI Engine のスモークテスト（002 T019・T020）

AI解禁の最初の作業。Pi（`@earendil-works/pi-ai`）経由で、さくらのAI Engine のツール呼び出しが安定するかを確かめた。

## どこで流したか

`docs/解禁の日の手順.md` では手元の Workshop で流す予定だったが、VPS の配備を先に済ませていたので、**VPS で `factory` ユーザーとして流した**。

- APIキーは VPS の `/etc/sakura-factory/factory.env` にもうあるので、手元で入力し直さずに済む
- 記録が VPS の DB（`/var/lib/sakura-factory/factory.db`）に入るので、予算ゲートが今月の消費として数える。手元で使った分を VPS の `monthly_requests` から引く作業（手順書4章）が要らなくなる

```bash
# /tmp/smoke.sh（VPS）: factory.env を読み、FACTORY_CONFIG=/etc/sakura-factory/factory.toml で node src/smoke-llm.ts を動かす
sudo runuser -u factory -- bash /tmp/smoke.sh
sudo runuser -u factory -- bash /tmp/smoke.sh --role verifier
sudo runuser -u factory -- bash /tmp/smoke.sh --raw
```

## base_url とモデル名

`GET https://api.ai.sakura.ad.jp/v1/models` で確かめた。`base_url` は仮の値のまま正しかった。モデルの ID は、プレビューのものに `preview/` が付く。

| 役 | 仮の値 | 実際の ID |
|---|---|---|
| 計画役・実装役 | `Kimi-K2.7-Code` | `preview/Kimi-K2.7-Code` |
| 検査役 | `Qwen3.6` | `preview/Qwen3.6-35B-A3B` |
| 検査役の比較用 | `gemma-4` | `preview/gemma-4-31B-it` |
| 退避先 | `gpt-oss-120b` | `gpt-oss-120b`（正式版） |

一覧にはほかに `preview/GLM-5.3-Flash`・`preview/DeepSeek-V4.1-Flash-1017`・`llm-jp-3.1-8x13b-instruct4`・`preview/Qwen3-VL-30B-A3B-Instruct`・埋め込み・Whisper などがあった。

## 結果

互換フラグは既定値（`DEFAULT_SAKURA_COMPAT`）のまま変えずに、3つとも全項目合格。

```
provider: sakura  model: preview/Kimi-K2.7-Code  mode: pi  compat: {"supportsDeveloperRole":false,"supportsReasoningEffort":false,"supportsStore":false,"supportsUsageInStreaming":true,"supportsStrictMode":false,"maxTokensField":"max_tokens"}
[PASS] a テキストの応答が返る
[PASS] b ツール呼び出しが構造化されて返る
[PASS] c 引数がツールの定義に合う
[PASS] d ツール結果のあとに続きの応答が返る
[PASS] e 本文にツール呼び出しの記法が漏れていない
[PASS] f 入出力トークン数が取れる
requests: 3
```

`--role verifier`（`preview/Qwen3.6-35B-A3B`、Pi）と `--raw`（`preview/Kimi-K2.7-Code`、素の HTTP・ストリーミング）も同じく6項目合格、各3リクエスト。

`llm_calls` の記録（9行。表示の `requests` の合計 9 と一致）:

| role | model | status | 入力 | 出力 | 応答時間 ms |
|---|---|---|---|---|---|
| implementer | preview/Kimi-K2.7-Code | ok | 48 | 15 | 595 |
| implementer | preview/Kimi-K2.7-Code | ok | 130 | 49 | 1964 |
| implementer | preview/Kimi-K2.7-Code | ok | 204 | 42 | 1286 |
| verifier | preview/Qwen3.6-35B-A3B | ok | 40 | 292 | 1543 |
| verifier | preview/Qwen3.6-35B-A3B | ok | 328 | 213 | 1253 |
| verifier | preview/Qwen3.6-35B-A3B | ok | 562 | 65 | 412 |
| implementer（raw） | preview/Kimi-K2.7-Code | ok | 48 | 55 | 1055 |
| implementer（raw） | preview/Kimi-K2.7-Code | ok | 130 | 44 | 833 |
| implementer（raw） | preview/Kimi-K2.7-Code | ok | 173 | 72 | 810 |

- 再試行は0回（すべて `attempt = 1`）
- Qwen3.6 は短い問いでも出力が 200〜300 トークンと多い（思考の分が出力に数えられている可能性）
- `GET /v1/models` はチャットの生成ではないので、月の枠（チャット生成 3,000 回）には数えない前提で扱った（`llm_calls` にも記録しない）

## 判断

**Pi を続ける。** 互換フラグは既定値のままでよく、`src/llm/provider.ts` は変えない。TanStack AI への切り替えは不要。

## まだ分かっていないこと

- `contextWindow`・`maxTokens` の実際の値。`/v1/models` の応答には含まれない。`provider.ts` の定数（131,072 など）のまま進め、長い作業で上限に当たったら直す
