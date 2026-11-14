# Data Model: 出荷とレポート（008）

データベースのスキーマ（001）は変えない。

## 出荷前チェックの結果（`ShipCheckResult`、メモリの中と `job_events` の JSON）

6つの条件（FR-002）を、毎回すべて評価する。

| `name` | 満たす条件 | `value`（記録とレポートに書く値） |
|---|---|---|
| `verdict` | 検査役の判定が合格 | `"pass"` |
| `diff_size` | 追加と削除の合計 ≤ `max_diff_lines` | `{ "lines": 42, "max": 300 }` |
| `forbidden_paths` | 禁止パスに当たるファイルがない | `{ "matched": [{ "path": "deploy/x.sh", "pattern": "deploy/**" }] }` |
| `secrets` | gitleaks で見つからない | `{ "status": "clean" }`／`{ "status": "found", "findings": [{ "file", "line", "rule" }] }`／`{ "status": "unavailable", "error": "..." }` |
| `skip_label` | Issue に `skip_label` がない | `{ "label": "no-auto-merge", "present": false }`／取得の失敗は `{ "label", "error" }` |
| `work_type` | `plan.work_type` が `allowed_work_types` に含まれる | `{ "work_type": "docs", "allowed": [...] }`。計画がなければ `work_type: null` |

- `secrets.findings` に値（秘密情報そのもの）を入れない。ファイル・行・規則の名前だけ
- **push してよいか**（`blocker`）: `secrets` が `found`・`unavailable` → `secret_detected`。`forbidden_paths` の `matched` に `.github/workflows/` の下がある → `unshippable_change`。どちらもなければ push する（両方なら `secret_detected` を優先）

## 出荷の振り分け（`MergeDecision`）

| `decision` | いつ |
|---|---|
| `auto_merge` | 6条件をすべて満たし、auto-merge の有効化に成功した |
| `draft` | 満たさない条件がある、または auto-merge を有効にできず Draft に変えた |
| `unsettled` | auto-merge の有効化と Draft への変更の両方に失敗した（PR はそのまま） |

- `unmet`: 満たさなかった条件の `name` の一覧（6条件の順）
- `notes`: 振り分けの補足（`auto_merge_failed: <GitHub の理由>`、`draft_unavailable`〔Draft を作れず通常の PR にした〕など）。マスク済み

## Job（`jobs`、001）の使い方の追加

| 列 | 008 での値 |
|---|---|
| `status` | 出荷に成功したら `ci_waiting`（`judging` → `pr_opened` → `ci_waiting` を1つのトランザクションで） |
| `pr_number` | 作った PR の番号 |
| `failure_reason` | 出荷前の失敗は `secret_detected: ...`・`unshippable_change: ...`・`ship_failed: ...` |

## 状態の遷移（007 の表のまま）

```
judging ──(合格・出荷前チェック → push → PR)──▶ pr_opened ──▶ ci_waiting
judging ──(秘密情報・CI の定義・push や PR の失敗・停止・期限)──▶ failed
```

- 起動時の掃除の対象は 007 のまま `planning`〜`judging`。`ci_waiting` のジョブは残る（009 が `check_suite` で再開する）
- push のあと PR を作る前に止まったジョブは `judging` のまま残り、起動時に `restarted` で報告される

## 失敗の理由の分類（`FailureKind`）の変更

| 分類 | 変更 | いつ |
|---|---|---|
| `shipping_not_available` | 消す | — |
| `secret_detected` | 足す | gitleaks で見つかった、`gitleaks:allow` の追加、スキャンできなかった（push しない） |
| `unshippable_change` | 足す | `.github/workflows/` の下を変えた（push しない） |
| `ship_failed` | 足す | commit・push・PR の作成に失敗した |

## JobEvent（`job_events`、001）の使い方の追加

| `type` | `detail`（JSON） | いつ |
|---|---|---|
| `note` | `{"kind":"ship_checks","conditions":[...],"blocker":null}` | 出荷前チェックを評価したあと（push の前） |
| `note` | `{"kind":"shipped","pr_number","pr_url","decision","unmet":[...],"notes":[...]}` | PR を作り、振り分けを終えたあと |
| `note` | `{"kind":"ship_report_posted","comment_url"}` | Issue に出荷の知らせを投稿した |
| `error` | `{"kind":"ship_report_failed","message"}` | Issue への出荷の知らせの投稿に失敗した（ジョブは `ci_waiting` のまま） |
| `state_changed` | `{"pr_number"}` | `judging` → `pr_opened`、`pr_opened` → `ci_waiting` |

- 007 の `report_posted`（失敗の報告）とは別の `kind` にする。失敗の報告の「1回だけ」の判定（`report_posted` を探す）に、出荷の知らせが混ざらないようにする

## 設定（`factory.toml` の `[auto_merge]`）

contracts/factory-toml.md。001 の `max_diff_lines`・`forbidden_paths`・`allowed_work_types` に `skip_label` を足し、`forbidden_paths` の既定に `.gitleaks.toml`・`.gitleaksignore` を足す。
