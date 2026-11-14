# Contract: 開発用の CLI `pnpm run ship:dev`（008）

AI解禁の前に、出荷の工程（`shipJob`）だけを本物の GitHub で試す（research R10）。LLM は呼ばない。手動でだけ実行する。

```bash
pnpm run ship:dev -- --repo Coxless/factory-sandbox --issue 1 --patch ./change.diff \
  [--work-type docs] [--summary "README に検査の説明を足す"] [--db data/ship-dev.db]
```

| 引数 | 必須 | 意味 |
|---|---|---|
| `--repo` | ✅ | 対象リポジトリ（`owner/name`）。App が入っていること |
| `--issue` | ✅ | 参照する Issue の番号（ラベルの確認と知らせのコメントに使う） |
| `--patch` | ✅ | 当てる変更（`git diff` の出力。`git apply` で当てる） |
| `--work-type` | | 偽の計画の作業の種類（既定 `docs`）。`WORK_TYPES` のどれか |
| `--summary` | | 偽の計画の概要（PR の題になる。既定 `ship:dev による出荷の確認`） |
| `--db` | | 記録するデータベース（既定は一時ディレクトリ）。本番のデータベースを指定しない |

- 環境変数: `FACTORY_CONFIG`（設定）、`GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY_PATH`（App）。`GITHUB_WEBHOOK_SECRET` と LLM の APIキーは要らない
- 流れ: データベースにジョブを1件作る（`trigger_comment_id` は実行した時刻）→ `judging` まで進める → 007 の `cloneForJob` で取得 → パッチを当てる → 偽の 005 の結果（`outcome: "passed"`、判定の理由は「ship:dev による確認」、`requests: 0`）を作る → `shipJob` を呼ぶ
- 出力（標準出力）: `PR: <url>`、`decision: <auto_merge|draft|unsettled>`、満たさなかった条件。失敗なら分類と理由
- 終了コード: 0 出荷した、1 出荷前・出荷中に失敗した（Issue に失敗の報告が付く）、2 引数・設定の誤り
- 作業ディレクトリは一時ディレクトリに作り、終わったら消す
- 本物の GitHub に PR とコメントを作るので、テスト用のリポジトリにだけ使う
