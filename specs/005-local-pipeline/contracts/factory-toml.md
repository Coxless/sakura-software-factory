# Contract: `factory.toml` の `[pipeline]`（005）

計画から判定までの工程の設定。`factory.toml`・`factory.dev.toml` に同じ既定を書く。値は仮の値で、012 の回帰評価と AI解禁後の調整で直す。

```toml
[pipeline]
# 工程内テストのコマンド（作業場の中で sh -c で順に実行。最初に失敗したところで止める）
# 対象リポジトリの CI と同じコマンドにする。空にすると工程内テストを飛ばす（起動時に警告）
check_commands = ["pnpm run check"]
check_timeout_seconds = 600   # 1コマンドの時間の上限（10〜3600）。ジョブの期限が先に来ればそちら
max_check_feedbacks = 3       # 1回の実装工程で、テストの失敗を実装役に差し込む回数の上限（0〜10）
max_check_log_chars = 8000    # 差し込み・判定に渡すテストのログの上限（1000〜100000、先頭と末尾を残す）
max_diff_chars = 40000        # 検査役・やり直しに渡す diff の上限（1000〜400000）
max_file_list_chars = 10000   # 計画役に渡すファイル一覧の上限（1000〜100000）
```

| 項目 | 型 | 既定 | 範囲 |
|---|---|---|---|
| `check_commands` | string[]（各1文字以上） | `["pnpm run check"]` | 0件以上 |
| `check_timeout_seconds` | integer | 600 | 10〜3600 |
| `max_check_feedbacks` | integer | 3 | 0〜10 |
| `max_check_log_chars` | integer | 8000 | 1000〜100000 |
| `max_diff_chars` | integer | 40000 | 1000〜400000 |
| `max_file_list_chars` | integer | 10000 | 1000〜100000 |

## 既存の項目の使い方

- `[limits].judge_retries`: 不合格（判定の不合格・テスト失敗・変更なし・ターン数の上限・拒否が続いた）のやり直しの上限。実装工程は最大 `judge_retries + 1` 回
- `[limits].job_timeout_minutes`: CLI の既定の期限（007 は自分で期限を決めて渡す）
- `[limits].max_turns_per_phase`: 実装工程1回のターン数の上限（004。工程内テストの差し込み後のターンも数える）
- `[models].planner`・`[models].verifier`: 計画役・検査役のモデル。`verifier` が `implementer` と同じなら工程を始めない
- `[implementer].max_issue_chars`・`max_agents_md_chars`・`max_plan_chars`: 計画役・検査役の入力の切り詰めにも使う

## 設定の検証に足すもの

- `[auto_merge].allowed_work_types` の各値は、作業の種類の一覧（`bugfix`・`test`・`docs`・`refactor`・`feature`・`chore`）のどれかでなければならない（計画の `work_type` と照らすため）
- `[pipeline]` は省略できる（すべて既定）。未知の項目は誤り（001 と同じ）
