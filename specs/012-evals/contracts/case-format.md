# Contract: 評価のケースの形（`evals/`）

```
evals/
├── README.md
├── projects/<name>/        # 対象のプロジェクト（複数のケースで共有してよい）
└── cases/<id>/
    ├── case.toml           # 必須
    ├── issue.md            # 必須。1行目がタイトル、残りが本文（005 の pipeline:dev と同じ）
    ├── setup/              # 任意。複製したプロジェクトに重ねてから初期コミットする（初期状態）
    ├── hidden/             # 任意。工程が終わったあとに作業ディレクトリの同じ相対パスに上書きで置く
    └── solution/           # 必須。模範解答。自己確認で setup のあとに重ねる
```

`<id>` はディレクトリ名で、`^[a-z0-9][a-z0-9-]{0,63}$`。

## case.toml

```toml
work_type = "bugfix"                 # bugfix / test / docs / refactor / feature / chore
project = "projects/inventory"       # evals/ からの相対パス
# instruction = "..."                # 任意。依頼の本文（@agent のあと）
# install = "pnpm install --frozen-lockfile"   # 任意。ネットワークありの一時コンテナで1回

# 工程内テスト（評価の間だけ [pipeline].check_commands を差し替える）
check_commands = ['node --test "test/**/*.test.ts"', "node scripts/lint.ts"]

[grader]
# 合格条件。作業場の中で sh -c で順に実行し、すべて終了コード 0 なら合格
commands = ['node --test ".eval/**/*.test.ts"']
timeout_seconds = 300                # 1コマンドの上限（10〜1800）
```

- 未知の項目は拒む（綴りの誤りを見つけるため）
- `hidden/` に置くファイルは、実装役が触らない場所（例 `.eval/`）を使う。同名のファイルがあれば上書きする
- 隠しのファイル・合格条件のコマンドは、計画役・実装役・検査役に渡さない

## 自己確認の規則（`pnpm run eval:dev -- --self-check`）

各ケースで次が成り立つこと:

1. プロジェクト＋`setup/` の状態で、合格条件が**失敗する**
2. さらに `solution/` を重ねた状態で、`check_commands` と合格条件が**すべて通る**
