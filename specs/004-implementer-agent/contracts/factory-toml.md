# Contract: `factory.toml` の追加分（004）

001 の [factory-toml.md](../../001-foundation/contracts/factory-toml.md) に表を1つ足す。規則（未知の項目はエラー、秘密情報は書かない）は 001 と同じ。表ごと省略でき、省略すると既定値が入る。

ターン数の上限は既存の `[limits].max_turns_per_phase`（既定 40）を使う。新しい項目は足さない。

## `[implementer]`（実装役のハーネス）

| 項目 | 型 | 既定 | 制約・説明 |
|---|---|---|---|
| `max_consecutive_blocks` | integer | `5` | 1〜50。検査による拒否がこの回数続いたら工程を止める（FR-011） |
| `compaction_ratio` | number | `0.7` | 0.3〜0.95。入力の見積もりが「モデルのコンテキストの上限 × この値」を超えたら古いツールの結果を縮める（FR-016） |
| `keep_recent_turns` | integer | `4` | 1〜20。圧縮で残す直近のターン数 |
| `max_agents_md_chars` | integer | `20000` | 1000〜200000。AGENTS.md を入力に入れるときの上限（FR-017） |
| `max_issue_chars` | integer | `20000` | 1000〜200000。Issue 文の上限 |
| `max_plan_chars` | integer | `20000` | 1000〜200000。計画の上限 |
| `max_feedback_chars` | integer | `30000` | 1000〜200000。追加のフィードバック（全部の合計）の上限 |

既定の値は仮の値。012 の回帰評価と AI解禁後の実機の調整で直す。

```toml
[implementer]
# 実装役のハーネス。項目の説明: specs/004-implementer-agent/contracts/factory-toml.md
max_consecutive_blocks = 5   # 検査の拒否がこの回数続いたら止める
compaction_ratio = 0.7       # 入力がコンテキストの上限のこの割合を超えたら古いツールの結果を縮める
keep_recent_turns = 4        # 圧縮で残す直近のターン数
max_agents_md_chars = 20000
max_issue_chars = 20000
max_plan_chars = 20000
max_feedback_chars = 30000
```

`factory.toml` と `factory.dev.toml` の両方に、上の既定値のまま書き足す。
