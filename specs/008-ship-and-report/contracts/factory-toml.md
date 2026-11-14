# Contract: `factory.toml` の追加分（008）

001 の [factory-toml.md](../../001-foundation/contracts/factory-toml.md) の `[auto_merge]` に足す。

```toml
[auto_merge]
max_diff_lines = 300   # 既存（001）。これを超える diff は Draft PR にする
# 変更したら自動マージしないパス（glob）。.github/workflows の下は push もしない（App に権限がない）
forbidden_paths = [
  ".github/workflows/**",
  ".env*",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "deploy/**",
  ".gitleaks.toml",
  ".gitleaksignore",
]
allowed_work_types = ["bugfix", "test", "docs", "refactor"]   # 既存（001）
skip_label = "no-auto-merge"   # Issue にこのラベルがあれば Draft にする
```

| 項目 | 型 | 既定 | 範囲 |
|---|---|---|---|
| `auto_merge.skip_label` | 文字列 | `"no-auto-merge"` | 空でない、50 文字以下（GitHub のラベルの上限） |
| `auto_merge.forbidden_paths` | 文字列の配列 | 上のとおり（`.gitleaks.toml`・`.gitleaksignore` を足した） | 各要素は空でない |

- `max_diff_lines`・`allowed_work_types` の範囲と検証は 001 のまま（`allowed_work_types` は `WORK_TYPES` のどれか）
- `forbidden_paths` に `.github/workflows/**` がなくても、`.github/workflows/` の下の変更は push しない（FR-005。App の権限で GitHub が拒否するため、設定で外せない）
- ラベルの比較は大文字と小文字を区別しない（GitHub のラベルの名前は大文字と小文字を区別せずに一意）
