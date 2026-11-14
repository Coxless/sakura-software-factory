# Quickstart: 出荷とレポート（008）

本機能が動くことを確かめる手順。コマンドは Workshop の中で実行する（`workshop exec dev -- <command>`）。

## 1. 自動テスト（GitHub・LLM なし）

```bash
pnpm run check
```

- `src/github/git.test.ts`: ローカルの bare リポジトリで commit（作成者がボット、追跡していないファイルを含む、`.gitignore` に従う、フックが動かない）と push（強制しない、既にある作業ブランチは拒否、トークンが `.git/config`・引数に出ない）
- `src/pipeline/ship-checks.test.ts`: 6条件の各組み合わせ、名前の変更の両方のパス、`.github/workflows` は push しない。本物の gitleaks で、見つかる・見つからない・作業ツリーの `.gitleaks.toml` の許可が効かない・基準の許可は効く・`gitleaks:allow` を見つかったものにする・範囲の誤り（走査 0）をスキャンできないにする
- `src/pipeline/ship.test.ts`: 偽の GitHub で、auto-merge・Draft・auto-merge の失敗から Draft・Draft を作れない・`unsettled`・秘密情報で push しない・push の失敗・停止と期限（push の前と後）・状態が `ci_waiting` で `pr_number` が入る・知らせが1回
- `src/pipeline/worker.test.ts`: 合格で出荷に進む、`ci_waiting` のジョブは起動時の掃除で残る
- `src/pipeline/report.test.ts`: まとめレポート・知らせ・失敗の報告の文面、マスク、長さの上限

## 2. 本物の GitHub で出荷だけを試す（`ship:dev`、AI解禁の前）

前提:
- 007 の確認で作った App（`coxless-sakura-factory`）が `Coxless/factory-sandbox` に入っている
- `factory-sandbox` に CI（`pnpm run check` を実行する GitHub Actions）、main のブランチ保護（CI を必須チェック）、auto-merge の許可がある

```bash
export FACTORY_CONFIG=/project/data/verify/factory.toml GITHUB_APP_ID="$(cat /project/data/secrets/app-id)" \
  GITHUB_APP_PRIVATE_KEY_PATH=/project/data/secrets/github-app.pem
```

| # | 操作 | 期待 |
|---|---|---|
| 1 | README を1行直すパッチで `pnpm run ship:dev -- --repo Coxless/factory-sandbox --issue <n> --patch readme.diff --work-type docs` | `decision: auto_merge`。PR に auto-merge が予約され、CI が通ると main にマージされる。PR の本文に6条件がすべて ✅。Issue に PR へのリンクが1回 |
| 2 | 同じパッチを `--work-type feature` で | `decision: draft`（`work_type`）。PR は Draft |
| 3 | Issue に `no-auto-merge` ラベルを付けて 1 と同じ | `decision: draft`（`skip_label`） |
| 4 | `pnpm-lock.yaml` を変えるパッチ | `decision: draft`（`forbidden_paths`） |
| 5 | 本物の形の偽のトークン（`ghp_` と 36 文字）を足すパッチ | push されない（リモートに作業ブランチがない）。Issue に `secret_detected` の失敗の報告（ファイルと行だけ） |
| 6 | （任意）ブランチ保護を外して 1 と同じ | auto-merge を有効にできず `decision: draft`、理由に GitHub の文 |

結果は `docs/journal/` に書く。AI解禁のあとは、Issue の `@agent` から 007 の常駐の流れで同じことを確かめる（007 の quickstart 3章）。
