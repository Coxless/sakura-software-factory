# Contract: factory.toml（012 で使う項目）

```toml
[models]
verifier = "Qwen3.6"
verifier_alt = "gemma-4"   # 任意。検査役の比較用（012）。あれば評価で比較用の判定を行う。implementer と同じ値は不可

[storage]
eval_dir = "data/evals"    # 任意（既定 "data/evals"）。評価の結果のファイルの置き場所。相対パスはこのファイルのディレクトリが基準
```

- `verifier_alt` は 001 で予約済みの項目（`src/config.ts`）。評価以外（Worker・pipeline:dev）では使わない
- 評価では、ケースの `check_commands` で `[pipeline].check_commands` を、評価全体の上限で `[budget].per_job_requests` を、実行の間だけ設定のコピーの上で差し替える。ファイルは書き換えない
- 開発用の `factory.dev.toml` は `eval_dir = "data/evals-dev"` にして、さくらの結果と混ぜない
