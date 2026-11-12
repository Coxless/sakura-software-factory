# Contract: `pnpm run pipeline:dev`（005）

ローカルのリポジトリと Issue 文で、計画から判定までを1回通す（手動でだけ実行する）。004 の `pnpm run implement:dev` を置き換える（`implement:dev` は削除）。

```sh
FACTORY_CONFIG=factory.dev.toml GEMINI_API_KEY=... \
  pnpm run pipeline:dev -- --repo <path> --issue <file> [options]
```

| 引数 | 必須 | 内容 |
|---|---|---|
| `--repo <path>` | ✅ | ローカルの git リポジトリ。`git clone --local --no-hardlinks` で一時ディレクトリに複製し、元は変えない |
| `--issue <file>` | ✅ | Issue 文のファイル。1行目をタイトル、残りを本文とする |
| `--instruction <file>` | | 依頼の本文（`@agent` のあとの文）のファイル |
| `--plan <file>` | | 計画のファイル。渡すと計画役を呼ばずにこれを使う |
| `--install <command>` | | 依存のインストールのコマンド（ネットワークありの一時コンテナ。例 `pnpm install --frozen-lockfile`） |
| `--max-turns <n>` | | 実装工程1回のターン数の上限（既定 `[limits].max_turns_per_phase`） |
| `--timeout-minutes <n>` | | 期限（既定 `[limits].job_timeout_minutes`） |
| `--allow-sakura` | | `[llm].provider = "sakura"` の設定で実行するときに必須（AI解禁前に誤って さくらを呼ばないため） |
| `--json` | | 結果を JSON で出す |

## 動き

1. 設定を読み、提供元が さくらで `--allow-sakura` がなければ終了コード 2
2. 開発用の設定（`google-ai-studio`）なら「公開してよいリポジトリと Issue 文だけを送ること」を標準エラーに表示する
3. APIキー（`[llm].provider` に応じた環境変数）がなければ終了コード 2（LLM は呼ばない）
4. `jobs` に1行（`repo = "local:<ディレクトリ名>"`、`requested_by = "dev"`）を作り、複製・依存のインストール・作業場の作成を行う
5. `runPipeline` を実行する。工程の境目を標準エラーに1行ずつ出す
6. 結果を表示し、作業場を片付ける。複製（変更済み）は残す
7. SIGINT（Ctrl-C）で中断し、作業場を片付けてから終了コード 3

## 表示（`--json` なし）

```
provider: google-ai-studio  planner: … implementer: … verifier: …  job: 12
workdir: /tmp/factory-pipeline-dev-XXXX/repo
outcome: passed  rounds: 2  requests: 23
plan: <概要>（work_type: bugfix）
verdict: pass — <理由>
reason: <最後の判定の理由、または不合格・失敗の理由>
diff: 3 files, +40 -5
trace: data/traces-dev/job-12.jsonl
--- rounds ---
1: implement=completed checks=failed(fed back 3) verdict=not_judged reason=checks_failed
2: implement=completed checks=passed verdict=pass
--- diff stat ---
3 files, +40 -5
```

表示する文字列はすべてマスク済み（diff の本文は表示しない。`--json` では `diff` を含めるが、これもマスクしてから出す）。

## 終了コード

| コード | 意味 |
|---|---|
| 0 | `passed` |
| 1 | `rejected` |
| 2 | 実行前の失敗（引数・設定・APIキー・データベース・複製・インストール・作業場の作成） |
| 3 | `failed`・`budget_exceeded`・`timeout`・`aborted` |
