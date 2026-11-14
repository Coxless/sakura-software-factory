# Contract: `pnpm run eval:dev`・`pnpm run eval:compare`

## eval:dev

```sh
FACTORY_CONFIG=factory.dev.toml GEMINI_API_KEY=... pnpm run eval:dev -- [options]
pnpm run eval:dev -- --self-check [--cases a,b]      # LLM を使わない
```

| 引数 | 内容 |
|---|---|
| `--set <dir>` | 評価のセット（既定 `evals`） |
| `--cases <id,id>` | 実行するケースを絞る |
| `--repeat <n>` | 各ケースの回数（既定 1） |
| `--max-requests <n>` | 評価全体のリクエスト上限（既定 ケース数 × 回数 × `[budget].per_job_requests`） |
| `--baseline <file>` | 比較の相手（既定は直前の実行） |
| `--timeout-minutes <n>` | 1ケースの期限（既定 `[limits].job_timeout_minutes`） |
| `--allow-sakura` | `[llm].provider = "sakura"` で実行するときに必須 |
| `--self-check` | 自己確認だけを行う（APIキー・DB・LLM を使わない） |
| `--json` | 結果を JSON で出す（結果のファイルと同じ形＋`comparison`） |

### 動き

1. 引数・設定・セットを読む（誤りは終了コード 2、LLM を呼ばない）。`verifier` か `verifier_alt` が `implementer` と同じなら 2
2. 提供元が さくらで `--allow-sakura` がなければ 2。開発用の設定なら公開データだけを送ることを標準エラーに表示
3. APIキーがなければ 2
4. 見積もり（ケース数・回数・上限・1ジョブの上限から最大の消費）を標準エラーに表示
5. ケースを順に実行する（各ケースの境目と工程の境目を標準エラーに1行ずつ）
6. 結果のファイルを書き、集計と比較を標準出力に表示する
7. SIGINT で中断し、実行中のケースの作業場を片付け、結果を `stopped = "aborted"` で書いてから終了コード 3

### 表示（`--json` なし）

```
set: evals  cases: 5 × 1  provider: google-ai-studio  verifier: … verifier_alt: …
result: data/evals-dev/20261114T101500Z-evals.json
--- cases ---
test-format-price#1        succeeded  requests=22  time=4m10s  retries=0
bugfix-parse-quantity#1    failed     requests=41  time=9m02s  retries=2  pipeline:rejected — <理由>
lint-no-console#1          failed     requests=19  time=3m30s  retries=0  grader — 隠しチェックが通りませんでした
--- summary ---
success: 3/5 (60.0%)  requests: 151 (avg 30.2)  time: avg 6m20s  errors: 0  not run: 0
by work type: test 1/1  bugfix 0/1  ...
--- verifiers ---
verifier     Qwen3.6  accuracy 3/4 (75.0%)  false pass 1  false fail 0  undecided 0  tokens in 5000 / out 240  latency 4.0s
verifier_alt gemma-4  accuracy 4/4 (100%)  ...
--- vs 20261113T090000Z-evals ---
success: 40.0% → 60.0% (+20.0pt)  avg requests: 35.0 → 30.2 (-4.8)  avg time: 7m00s → 6m20s (-40s)
improved: test-format-price#1
regressed: (なし)
config: implementer gemini-3.5-flash-lite → gemini-3.6-flash; commit 1234567 → 89abcde
```

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 全件を実行した（成否は問わない）／自己確認がすべて成り立った |
| 1 | 自己確認で成り立たないケースがあった |
| 2 | 実行前の誤り（引数・設定・セット・APIキー・さくらの拒否・DB） |
| 3 | 途中で止まった（上限・予算切れ・中断。未実行あり） |

## eval:compare

```sh
pnpm run eval:compare -- <baseline.json> <current.json> [--json]
```

LLM・DB・設定を使わない。2つの結果のファイルを読んで比較だけを表示する。終了コード 0 = 表示した、2 = 引数の誤り・読めない・形が合わない。
