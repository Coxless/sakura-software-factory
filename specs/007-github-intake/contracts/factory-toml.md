# Contract: `factory.toml` の追加分（007）

001 の [factory-toml.md](../../001-foundation/contracts/factory-toml.md) に足す。

```toml
[github]
allowed_users = ["Coxless"]     # 既存（001）
webhook_max_body_kb = 1024      # Webhook の本文の上限（64〜25600）
max_instruction_chars = 20000   # 依頼の本文の上限（100〜200000）

[worker]
poll_interval_seconds = 5       # キューを見る間隔（1〜300）。積んだときはすぐ取り出す

[storage]
work_dir = "data/work"          # ジョブごとの作業ディレクトリの置き場所。相対パスは設定ファイルの場所が基準

[pipeline]
# 依存のインストールのコマンド（ネットワークありの一時的な作業場で sh -c で1回実行）
# 対象リポジトリの CI と同じにする。空にするとインストールを飛ばす（起動時に警告）
install_command = "pnpm install --frozen-lockfile"
```

| 項目 | 型 | 既定 | 範囲 |
|---|---|---|---|
| `github.webhook_max_body_kb` | 整数 | 1024 | 64〜25600 |
| `github.max_instruction_chars` | 整数 | 20000 | 100〜200000 |
| `worker.poll_interval_seconds` | 整数 | 5 | 1〜300 |
| `storage.work_dir` | 文字列 | `"data/work"` | 空でない |
| `pipeline.install_command` | 文字列 | `"pnpm install --frozen-lockfile"` | 空文字を許す（飛ばす） |

- `[worker]` は省略できる
- `[pipeline]` は 005 の [factory-toml.md](../../005-local-pipeline/contracts/factory-toml.md) のセクションに項目を1つ足す。時間の上限は 003 の `[sandbox] install_timeout_seconds` を使う
- VPS の `/etc/sakura-factory/factory.toml` は、006 の `setup.sh` が初回に作るときに `work_dir = "/var/lib/sakura-factory/work"` に置き換える（`database_path`・`trace_dir` と同じ）
- 許可ユーザーの比較は大文字と小文字を区別しない
