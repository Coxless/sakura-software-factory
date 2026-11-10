# Contract: コマンド

## `pnpm run smoke:llm`（新規）

実機の さくらのAI Engine に対するスモークテスト。手動でだけ実行する（`pnpm run check` には含めない）。

```
pnpm run smoke:llm [-- --role <planner|implementer|verifier|verifier_alt|fallback>] [--raw [--no-stream]] [--compat <key=value> ...] [--json]
```

| 引数 | 既定 | 説明 |
|---|---|---|
| `--role` | `implementer` | 対象のモデルを `factory.toml` の `[models]` の項目名で選ぶ |
| `--raw` | なし | Pi を通さず、素の HTTP で送る（research R14）。Pi 経由と同じくストリーミングで送る |
| `--no-stream` | なし | `--raw` と併用し、`stream: false` で送る（さくらのストリーミング自体を切り分けるとき）。`--raw` なしではエラー |
| `--compat key=value` | なし | 互換フラグを一時的に上書きする（複数可。値は `true` / `false` / 文字列）。`--raw` とは併用しない |
| `--json` | なし | 結果を JSON で出す（journal に貼る用） |

- 環境変数: `SAKURA_AI_API_KEY`（必須）、`FACTORY_CONFIG`（任意）
- 前提: `factory.toml` の読み込みとマイグレーションの適用（未適用なら適用する）
- 呼び出しはゲートを通り、`llm_calls` に `job_id = NULL`, `phase = "smoke"` で記録される
- 1回の実行で 10 リクエスト以下

**出力（既定）**

```
model: Kimi-K2.7-Code  mode: pi  compat: {"supportsDeveloperRole":false,...}
[PASS] a テキストの応答が返る
[PASS] b ツール呼び出しが構造化されて返る
[FAIL] c 引数がツールの定義に合う  — got: {"location":"Tokyo"}
[PASS] d ツール結果のあとに続きの応答が返る
[PASS] e 本文にツール呼び出しの記法が漏れていない
[PASS] f 入出力トークン数が取れる
requests: 3
```

**終了コード**

| コード | 意味 |
|---|---|
| 0 | すべて合格 |
| 1 | 不合格の項目がある |
| 2 | 実行前の失敗（APIキーなし、設定エラー、予算切れ、恒久的な HTTP エラーなど）。原因を標準エラーに出す |

## 既存コマンドへの影響

- `pnpm run check`: 変わらない（新しいテストは偽の LLM だけを使う）
- `pnpm run db:generate` / `pnpm run db:migrate`: `llm_calls.error_kind` のマイグレーションが1つ増える
