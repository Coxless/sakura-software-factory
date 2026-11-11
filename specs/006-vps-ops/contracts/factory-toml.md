# Contract: `factory.toml` の追加分（006）

001 の [factory-toml.md](../../001-foundation/contracts/factory-toml.md) に足す。

```toml
[http]
# 待ち受け。Caddy から転送する（外から直接は届かない）。port は deploy/Caddyfile と合わせる
host = "127.0.0.1"
port = 8787
shutdown_timeout_seconds = 10   # 停止の合図のあと、処理中の要求を待つ上限（1〜60）
```

| 項目 | 型 | 既定 | 範囲 | 誤りのとき |
|---|---|---|---|---|
| `http.host` | 文字列 | `"127.0.0.1"` | 空でない | 起動しない（`ConfigError`） |
| `http.port` | 整数 | `8787` | 1〜65535 | 起動しない |
| `http.shutdown_timeout_seconds` | 整数 | `10` | 1〜60 | 起動しない |

- `[http]` は省略できる。省略したら既定値
- `host` がループバック以外のときは起動するが、`warn` を1行出す（「Caddy を通さずに公開しています」）
- `factory.dev.toml` にも同じ `[http]` を足す（開発用の設定でも `pnpm start` は provider の確認で止まるが、スキーマは同じにする）
- VPS の `/etc/sakura-factory/factory.toml` は、初回の配備でリポジトリの `factory.toml` から作り、`[storage]` を次に置き換える

```toml
[storage]
database_path = "/var/lib/sakura-factory/factory.db"
trace_dir = "/var/lib/sakura-factory/traces"
```
