# Contract: コマンド

## `pnpm run implement:dev`（新規）

開発用の LLM（Google AI Studio の無償枠）で、ローカルのリポジトリに対して実装工程を1回実行する。手動でだけ実行する（`pnpm run check` には含めない）。005 の CLI ができたら置き換えるか統合する。

```
pnpm run implement:dev -- --repo <path> --issue <file> --plan <file> [--install <command>] [--max-turns <n>] [--timeout-minutes <n>] [--allow-sakura] [--json]
```

| 引数 | 既定 | 説明 |
|---|---|---|
| `--repo` | 必須 | ローカルの git リポジトリ。一時ディレクトリに `git clone --local` して使い、元は書き換えない |
| `--issue` | 必須 | Issue 文（タイトルと本文）のファイル |
| `--plan` | 必須 | 計画のファイル（手書きでよい） |
| `--install` | なし | 依存のインストールのコマンド（例: `pnpm install --frozen-lockfile`）。ネットワークありの一時的な作業場で実行する（003） |
| `--max-turns` | `[limits].max_turns_per_phase` | ターン数の上限 |
| `--timeout-minutes` | `[limits].job_timeout_minutes` | 期限（今から何分後） |
| `--allow-sakura` | なし | `[llm].provider = "sakura"` のとき、これがなければ実行しない（FR-028） |
| `--json` | なし | 結果を JSON で出す（journal に貼る用） |

- 環境変数: 提供元の APIキー（`GEMINI_API_KEY`。さくらなら `SAKURA_AI_API_KEY`）、`FACTORY_CONFIG`（開発中は `factory.dev.toml`）
- 送るのは公開してよいリポジトリと Issue 文だけ（constitution 原則 I の例外の条件）
- 前提: 作業場のイメージ（`pnpm run sandbox:build`）、マイグレーションの適用（未適用なら適用する）
- `jobs` に開発用の行（`requested_by = "dev"`）を作り、その `job_id` で記録する。予算ゲートのジョブの上限が効く

**出力（既定）**

```
provider: google-ai-studio  model: gemini-3.5-flash-lite  job: 12
workspace: /tmp/factory-implement-dev-XXXX/repo
outcome: completed  turns: 7  requests: 7  tool calls: 9  blocked: 0
trace: data/traces-dev/job-12.jsonl
--- last message ---
（実装役の最後のメッセージ）
--- git diff --stat ---
 src/a.ts | 4 ++--
 1 file changed, 2 insertions(+), 2 deletions(-)
```

**終了コード**: `0` = `completed`、`1` = それ以外の終わり方、`2` = 引数・設定の誤り、またはさくらの設定で `--allow-sakura` がない

## `pnpm run check`（変更なし）

本機能のテストを含む。実際の LLM を呼ばない。Docker がなければ作業場を使うテスト（`*.docker.test.ts`）だけを飛ばす。
