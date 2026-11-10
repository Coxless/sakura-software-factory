# Contract: `factory.toml` の追加分（003）

001 の [factory-toml.md](../../001-foundation/contracts/factory-toml.md) に2つの表を足す。規則（未知の項目はエラー、秘密情報は書かない）は 001 と同じ。どちらの表も省略でき、省略すると既定値が入る。

## `[sandbox]`（作業場、層5）

| 項目 | 型 | 既定 | 制約・説明 |
|---|---|---|---|
| `image` | string | `"factory-sandbox:latest"` | 作業場のイメージ（`pnpm run sandbox:build` で作る） |
| `user` | string | なし（省略可） | `<uid>:<gid>`。省略時はファクトリーのプロセスと同じ uid:gid。uid 0 は不可。ファクトリーを root で動かす場合は必須（作業場の起動時にエラーにする） |
| `cpus` | number | `2` | > 0 |
| `memory_mb` | integer | `2048` | ≥ 128。スワップも同じ値で止める |
| `pids_limit` | integer | `512` | ≥ 16 |
| `tmp_size_mb` | integer | `512` | ≥ 16。`/tmp`（`HOME`）の大きさ |
| `install_timeout_seconds` | integer | `600` | ≥ 1。依存のインストールの時間の上限 |

## `[tools]`（4ツールと層3・層4）

| 項目 | 型 | 既定 | 制約・説明 |
|---|---|---|---|
| `bash_timeout_seconds` | integer | `120` | ≥ 1。`bash` で `timeout_seconds` を省いたときの上限 |
| `bash_max_timeout_seconds` | integer | `600` | ≥ 1、かつ ≥ `bash_timeout_seconds`。呼び出しで指定できる上限の最大 |
| `read_max_lines` | integer | `2000` | ≥ 1。`read_file` が1回で返す行数の上限 |
| `max_output_chars` | integer | `20000` | ≥ 1000。整形（層4）で切り詰める長さ |
| `deny_write_paths` | string[] | 下を参照 | glob（作業ディレクトリからの相対パス）。書き込み・部分置換を拒否する |

`deny_write_paths` の既定:

```toml
deny_write_paths = [
  ".git", ".git/**", "**/.git/**",
  ".github/workflows/**",
  ".env*", "**/.env*",
  "**/pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock",
  "deploy/**",
]
```

`[auto_merge] forbidden_paths`（層6: 変更されていたら自動マージしない）とは別の一覧。

## 検証エラーの例

```
factory.toml の検証に失敗しました（2件）
  /sandbox/user: <uid>:<gid> の形で、uid は 0 以外にしてください（現在 "0:0"）
  /tools/bash_timeout_seconds: bash_max_timeout_seconds（600）以下にしてください（現在 900）
```

## 環境変数

本機能で増える環境変数はない。テストだけが次を読む。

| 名前 | 用途 |
|---|---|
| `FACTORY_SANDBOX_TEST_IMAGE` | Docker を使うテストのイメージ（既定 `factory-sandbox:latest`） |
| `FACTORY_SANDBOX_TEST_USER` | Docker を使うテストの実行ユーザー（既定: テストを root で動かすときは `1000:1000`、それ以外はプロセスの uid:gid） |
