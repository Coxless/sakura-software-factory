# Quickstart: LLM層と予算ゲート（llm-budget-gate）の確かめ方

コマンドはすべて Workshop の中で実行する（`workshop exec dev -- bash -lc 'cd /project && <command>'`）。

## 1. 自動テスト（LLM を呼ばない）

```bash
pnpm install --frozen-lockfile
pnpm run check
```

期待する結果: すべて通る。ゲートのテストは偽の `fetch`（[contracts/module-api.md](./contracts/module-api.md) の `src/llm/testing.ts`）だけを使い、外部に接続しない。

主に確かめるシナリオ（spec の受け入れシナリオとの対応）:

| シナリオ | 対応 |
|---|---|
| 月の上限の手前で通り、上限ちょうどで送られない | US2-1, US2-2, SC-002 |
| ジョブの上限で止まり、別のジョブは通る | US2-3 |
| ジョブなしの呼び出しは月だけで判断 | US2-4 |
| 受付の可否（残り < 1ジョブの上限で拒否） | US2-5 |
| 月の境目（JST の月初）で数え直す | US2-6 |
| 429 → 成功で、記録2件・呼び出しは成功 | US3-1, SC-003, SC-004 |
| 500 が続くと `max_attempts` 回で失敗し、同数を記録 | US3-2 |
| 401・404 は再試行しない | US3-3, Edge（存在しないモデル） |
| 再試行の途中で予算が尽きる | US3-4 |
| 途中で切れた応答を呼び出し元に渡さない | US3-5 |
| 呼び出し元の取り消しは再試行しない | US3-6 |
| `retry-after` を守る・上限超えは失敗 | US3-7 |
| 記録の各列とマスク | US4-1〜4, SC-005 |
| 記録に失敗したら呼び出しを失敗にする | Edge |
| 偽の LLM の仕込み・尽きたときのエラー・受け取った入力 | US5-1〜4 |
| ゲートなしの呼び出しは例外 | SC-007 |

## 2. 実機のスモークテスト（さくらのAI Engine を呼ぶ・手動）

前提: `factory.toml` の `base_url` とモデル名、APIキー。1回の実行で 10 リクエスト以下を使う。

```bash
export SAKURA_AI_API_KEY=...   # 履歴に残さないよう注意
pnpm run smoke:llm                       # 実装役（Kimi-K2.7-Code）を Pi 経由で
pnpm run smoke:llm -- --raw              # 同じ確認を素の HTTP で（ストリーミング）
pnpm run smoke:llm -- --raw --no-stream  # 素の HTTP・非ストリーミング（ストリーミング自体を疑うとき）
pnpm run smoke:llm -- --role verifier    # 検査役のモデルで
pnpm run smoke:llm -- --compat supportsUsageInStreaming=false   # 互換フラグを変えて
```

期待する結果: 6項目（a〜f）の合否と、使ったリクエスト数が出る（形は [contracts/commands.md](./contracts/commands.md)）。

記録を確かめる:

```bash
sqlite3 data/factory.db "SELECT phase, role, model, attempt, status, error_kind, input_tokens, output_tokens, latency_ms FROM llm_calls WHERE phase = 'smoke' ORDER BY id DESC LIMIT 10;"
```

表示された `requests` の数と、増えた行の数が一致すること。

## 3. 結果から判断する（FR-026）

1. 全部合格 → Pi を続ける。使った互換フラグを `src/llm/provider.ts` の既定値に書き、`factory.toml` の仮の値を直す
2. 不合格がある → `--compat` を変えて再確認する
3. それでも不合格 → `--raw` で同じ確認をする
   - 素の HTTP は合格・Pi は不合格 → 予備（TanStack AI）へ切り替える。先に `docs/design/03` と constitution を直す
   - 両方不合格 → モデル側の問題。`--role` で別のモデル（退避先など）を試し、モデルの選定を見直す
4. 結果（各項目の合否、互換フラグ、モデル名、気づいた挙動、判断と理由）を `docs/journal/YYYY-MM-DD-sakura-tool-calling.md`（日付は書いた日） に書く。APIキーは書かない
