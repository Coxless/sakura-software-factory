# Quickstart: 計画・工程内テスト・判定（local-pipeline）

本機能が動くことを確かめる手順。コマンドは Workshop の中で実行する（`workshop exec dev -- <command>`、プロジェクトは `/project`）。

## 前提

- `workshop start dev` 済み、`pnpm install` 済み
- 作業場のイメージ: `pnpm run sandbox:build`（手動の確認だけで使う）
- 自動テストは実際の LLM もコンテナも使わない

## 1. 自動テスト（偽の LLM・偽の作業場）

```sh
workshop exec dev -- bash -lc 'cd /project && pnpm run check'
```

期待する結果（主なテストファイルと確かめること）:

| ファイル | 確かめること | spec |
|---|---|---|
| `src/harness/structured.test.ts` | コードブロック・前後の説明文つきの JSON を取り出せる。文字列の中の括弧で崩れない。検証の誤りが「パス: 理由」になる | US1・US3 |
| `src/llm/complete.test.ts` | 要求の本文に `tools` が含まれない。予算ゲートを通って `llm_calls` に1件。予算切れ・中断を返す | SC-002 |
| `src/pipeline/plan.test.ts` | 正しい形 → 1回。壊れた形 → 再要求 → 2回。2回とも壊れた → `invalid` で3回目なし。Issue の閉じタグが崩れる | US1、SC-003 |
| `src/pipeline/checks.test.ts` | 順に実行し最初の失敗で止まる。時間切れ。126・127 は `unavailable`。ログのマスクと切り詰め | US2 |
| `src/pipeline/verify.test.ts` | 合格・不合格・再要求・2回とも壊れた。diff の切り詰めの表示 | US3 |
| `src/pipeline/diff.test.ts` | 一時ディレクトリの git リポジトリで、追跡していない新しいファイルが diff に入り、インデックスが変わらない | FR-022 |
| `src/pipeline/run.test.ts` | 計画 → 実装 → テスト → 判定（合格）。テスト失敗の差し込み（上限まで）→ 検査役を呼ばない。1回目不合格 → 2回目合格（feedback に理由と diff）。ずっと不合格で `judge_retries + 1` 回。予算切れ・期限・中断。変更なし。同じモデルの拒否。`onPhase` の順。`llm_calls` と結果の `requests` と軌跡の件数が一致。秘密情報が軌跡に平文で残らない | US1〜US4、SC-001・003〜009 |
| `src/pipeline/implement.test.ts`（追加） | `onComplete` が文字列を返すと差し込んで続く。`undefined` で完了。ターン数の上限は数え続ける | R4 |
| `src/pipeline-dev.test.ts` | 引数の解析、`--allow-sakura` なしの さくらの拒否、終了コード、`--plan` で計画役を呼ばない、片付け | US5 |

## 2. 作業場を使う確認（Docker があるときだけ）

```sh
workshop exec dev -- bash -lc 'cd /project && pnpm run sandbox:build && pnpm vitest run src/pipeline/run.docker.test.ts'
```

偽の LLM ＋本物の作業場で、`check_commands = ["test -f done.txt"]` のような小さなコマンドが作業場の中で走り、失敗が差し込まれ、2回目の完了で通ることを確かめる。

## 3. 開発用の LLM で手動の確認（Google AI Studio。公開してよいデータだけ）

```sh
cat > /tmp/issue.md <<'EOF'
README に「開発環境」の節を足す
README.md に、Workshop で開発する手順（workshop launch dev / workshop exec dev -- pnpm run check）を短く書いてください。
EOF
workshop exec dev -- bash -lc 'cd /project && FACTORY_CONFIG=factory.dev.toml GEMINI_API_KEY=... \
  pnpm run pipeline:dev -- --repo /project --issue /tmp/issue.md --install "pnpm install --frozen-lockfile"'
```

期待する結果:

- 標準エラーに「公開してよいデータだけを送る」旨と、`planning` → `implementing` → `testing` → `judging` の境目が出る
- 終了コード 0（`passed`）か 1（`rejected`）。表示に計画の概要と `work_type`、判定の理由、各回の要約、diff の要約、軌跡の場所が出る
- `data/traces-dev/job-<id>.jsonl` に `pipeline_start`・`llm_request`・`validation`・`check_run`・`round_end`・`pipeline_end` が並ぶ
- `sqlite3 data/factory.dev.db "select phase, attempt, outcome, verdict, requests from agent_runs where job_id = <id>"` で `plan`・`implement`・`judge` の行が見える
- 結果（成功・失敗とも、数値と気づいたこと）を `docs/journal/` に書く

## 4. さくらで回す（AI解禁の日。`docs/実装計画.md` 3章の流れ）

```sh
SAKURA_AI_API_KEY=... pnpm run pipeline:dev -- --repo <公開のデモ用リポジトリ> --issue <file> --allow-sakura
```

`--allow-sakura` がないと終了コード 2 で止まり、LLM は呼ばれない。
