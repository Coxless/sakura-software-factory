# Contract: `factory.toml` の追加分（009）

001 の [factory-toml.md](../../001-foundation/contracts/factory-toml.md) に足す。

```toml
[limits]
ci_retries = 2                 # 既存（001）。CI 失敗後のやり直しの上限（0 でやり直さない）
ci_wait_timeout_minutes = 30   # 既存（001）。PR を作った・push してから CI の結論を待つ上限

[worker]
ci_check_interval_seconds = 60   # CI 待ちの見回りの間隔（10〜3600）。知らせを受けたときは待たずに見る

[pipeline]
max_ci_log_chars = 12000   # 実装役に渡す CI のログの合計の上限（1000〜100000）
```

| 項目 | 型 | 既定 | 範囲 |
|---|---|---|---|
| `worker.ci_check_interval_seconds` | 整数 | 60 | 10〜3600 |
| `pipeline.max_ci_log_chars` | 整数 | 12000 | 1000〜100000 |

- `limits.ci_retries`（0 以上）・`limits.ci_wait_timeout_minutes`（1 以上）の範囲と検証は 001 のまま
- 範囲の外の値・整数でない値では起動しない（項目の名前を含むエラー。001 の `ConfigError`）
