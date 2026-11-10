# Data Model: サンドボックスと4ツール（sandbox-tools）

本機能はデータベースのテーブルを追加しない。扱うのはメモリ上の値と、Docker のコンテナだけ。

## 作業場（Sandbox）

ジョブ専用のコンテナ1つを表すハンドル。

| 項目 | 型 | 説明 |
|---|---|---|
| `jobId` | number | ジョブ ID（`jobs.id`）。回帰評価などジョブに属さない場合は呼び出し側が決めた正の整数 |
| `name` | string | コンテナ名 `factory-job-<jobId>` |
| `workspace` | string | ホスト側の作業ディレクトリ（絶対パス）。コンテナ内では `/workspace` |

**状態の流れ**: なし → 起動済み（`createSandbox`）→ 片付け済み（`destroy`）。`destroy` は何度呼んでもよい。片付け済みのハンドルで `exec` するとエラー（作業場が使えない）を返す。

**コンテナに付ける印（ラベル）**:

| ラベル | 値 |
|---|---|
| `sakura-factory.sandbox` | `1`（ファクトリーが作ったもの。残骸の片付けで使う） |
| `sakura-factory.job-id` | ジョブ ID |
| `sakura-factory.kind` | `job`（実装工程）または `install`（依存のインストール） |

## コマンドの実行結果（ExecResult）

`docker exec` 1回の結果。ツールの中で使う。

| 項目 | 型 | 説明 |
|---|---|---|
| `exitCode` | number | 終了コード。打ち切り時は 124 または 137 |
| `stdout` / `stderr` | Uint8Array | 生のバイト列（上限まで） |
| `timedOut` | boolean | 時間の上限で打ち切ったか |
| `truncated` | boolean | 出力の取り込みの上限（5 MiB）を超えたか |
| `durationMs` | number | 所要時間 |

## ツール呼び出し（ToolCall）

検査（層3）と整形（層4）の入力。Pi の `BeforeToolCallContext` の `toolCall.name` と `args` に当たる。

| 項目 | 型 | 説明 |
|---|---|---|
| `toolName` | string | `read_file` / `write_file` / `edit_file` / `bash` |
| `args` | unknown | 引数（スキーマで検証済みとは限らない。検査側で形を確かめる） |

## ツールの結果（ToolResult）

Pi の `AgentToolResult` と同じ形。

| 項目 | 型 | 説明 |
|---|---|---|
| `content` | `{ type: "text"; text: string }[]` | モデルに返す文字列（1要素） |
| `details` | ToolDetails | 記録用の構造化した詳細（モデルには返さない） |
| `isError` | boolean | 誤用・拒否・作業場の異常なら true。`bash` の 0 以外の終了コードは false |

### ToolDetails（ツールごと）

| ツール | 項目 |
|---|---|
| 共通 | `tool`（ツール名）、`durationMs`、`error?`（エラーの種類: `invalid_args` / `not_found` / `is_directory` / `outside_workspace` / `no_match` / `multiple_matches` / `no_change` / `sandbox_unavailable` / `blocked`） |
| `read_file` | `path`、`startLine`、`endLine`、`totalLines`、`binary`、`truncated` |
| `write_file` | `path`、`bytes`、`created` |
| `edit_file` | `path`、`replacements` |
| `bash` | `exitCode`、`timedOut`、`timeoutSeconds`、`stdoutBytes`、`stderrBytes`、`outputTruncated` |
| 整形（層4）が足す | `trimmedChars?`（切り詰めで省いた文字数）、`masked?`（マスクで置き換えた箇所があったか） |

## 検査の判定（GuardDecision）

| 値 | 意味 |
|---|---|
| `undefined` | 許可（次の検査へ） |
| `{ block: true, reason: string, guard: string }` | 拒否。`reason` はモデルに返す文面、`guard` は拒否した検査の名前（軌跡用） |

## 設定（`factory.toml` の追加分）

形と既定値は [contracts/factory-toml.md](./contracts/factory-toml.md)。

- **SandboxConfig**（`[sandbox]`）: `image`、`user?`、`cpus`、`memory_mb`、`pids_limit`、`tmp_size_mb`、`install_timeout_seconds`
- **ToolsConfig**（`[tools]`）: `bash_timeout_seconds`、`bash_max_timeout_seconds`、`read_max_lines`、`max_output_chars`、`deny_write_paths`

**検証の追加ルール**: `bash_timeout_seconds ≤ bash_max_timeout_seconds`。`user` は `<uid>:<gid>`（数字）で、uid は 0 以外。
