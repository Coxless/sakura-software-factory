# Quickstart: 回帰評価（evals）

コマンドは Workshop の中で実行する（`workshop exec dev -- <command>`、プロジェクトは `/project`）。

## 1. 自動テスト（偽の LLM。LLM を呼ばない）

```sh
pnpm run check
```

- `src/evals/*.test.ts`: ケースの読み込み・実行器（成功／隠しチェックの失敗／工程の失敗／実行できない／上限・予算・中断）・比較・検査役の集計
- `src/evals/selfcheck.docker.test.ts`: Docker と作業場のイメージがあれば、`evals/` の全ケースで「何もしなければ隠しチェックが落ち、模範解答で通る」を確かめる（なければ理由を出して飛ばす）

## 2. 自己確認（Docker あり、LLM なし）

```sh
pnpm run sandbox:build
pnpm run eval:dev -- --self-check
```

期待: 全ケースが `ok`、終了コード 0。

## 3. 開発用の LLM で回す（Google AI Studio、公開データだけ）

```sh
FACTORY_CONFIG=factory.dev.toml GEMINI_API_KEY=... pnpm run eval:dev -- --cases bugfix-parse-quantity --max-requests 60
FACTORY_CONFIG=factory.dev.toml GEMINI_API_KEY=... pnpm run eval:dev -- --max-requests 250
```

期待: ケースごとの結果・集計が表示され、`data/evals-dev/<runId>.json` ができる。2回目以降は直前の実行との比較が出る。GitHub は呼ばれない。

## 4. 2つの結果を比べる（LLM なし）

```sh
pnpm run eval:compare -- data/evals-dev/<前>.json data/evals-dev/<後>.json
```

## 5. 12月の枠（さくら）での評価と検査役の比較

`factory.toml` の `[models].verifier_alt = "gemma-4"` を有効にしてから:

```sh
SAKURA_AI_API_KEY=... pnpm run eval:dev -- --allow-sakura --max-requests 300
```

期待: `--- verifiers ---` に Qwen3.6 と gemma-4 の一致率・誤合格・誤不合格・トークン・応答時間が並ぶ。
