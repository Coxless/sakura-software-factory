# Data Model: 回帰評価（evals）

DB のスキーマは変えない。評価のジョブは既存の `jobs` に1ケース1行、LLM の記録は既存の `llm_calls`・`agent_runs`。新しいのはファイル（ケースと結果）だけ。

## 1. 評価のケース（`evals/cases/<id>/`）

形の詳細は [contracts/case-format.md](./contracts/case-format.md)。

| 項目 | 型 | 規則 |
|---|---|---|
| id | string | ディレクトリ名。`^[a-z0-9][a-z0-9-]{0,63}$`。セット内で一意 |
| work_type | enum | 005 の計画の作業の種類（bugfix・test・docs・refactor・feature・chore） |
| title / body | string | `issue.md` の1行目と残り。タイトルは空にしない |
| instruction | string? | `case.toml` の `instruction`（依頼の本文） |
| project | string | `evals/` からの相対パス。存在するディレクトリ |
| install | string? | ネットワークありの一時コンテナで1回実行するコマンド |
| check_commands | string[] | 工程内テスト（`[pipeline].check_commands` を差し替える）。0件可 |
| grader.commands | string[] | 合格条件。1件以上 |
| grader.timeout_seconds | int | 1コマンドの時間の上限（10〜1800、既定 300） |
| setupDir / hiddenDir / solutionDir | path? | `setup/`（任意）・`hidden/`（任意）・`solution/`（必須） |
| hash | string | sha256。`case.toml`・`issue.md`・`setup/`・`hidden/`・`solution/`・プロジェクトのファイルの相対パスと内容から計算 |

**検証**: スキーマ違反・ID の重複・存在しない `project`・`solution/` がない・`grader.commands` が空・`issue.md` がない は、ケースの ID と理由を集めて `EvalSetError` で拒む。

## 2. ケースの結果（CaseResult）

| 項目 | 型 | 説明 |
|---|---|---|
| caseId | string | |
| caseHash | string | |
| workType | enum | |
| attempt | int | 1 始まり（`--repeat`） |
| status | `succeeded` / `failed` / `error` / `not_run` | `error` = 実行できない（作業場の異常など） |
| failure | `pipeline` / `grader` / undefined | 失敗の種類（工程の終わり方が passed 以外 / 隠しチェックの失敗） |
| reason | string | マスク済み。失敗・実行できない理由 |
| jobId | int? | 評価用のジョブ |
| pipeline | object? | `outcome`・`retries`・`rounds`（数）・`requests`・`diffStat`・`tracePath`・`planWorkType` |
| grader | object? | `status`（`passed` / `failed` / `unavailable`）・`results`（コマンド・終了コード・時間・打ち切り・マスクして切り詰めたログ） |
| verifier | Judgement? | 主の検査役の最後の判定（下記） |
| verifierAlt | Judgement? | 比較用の検査役の判定 |
| requests | int | ジョブの `llm_calls` の件数（比較用を含む） |
| durationMs | int | 工程の開始から隠しチェックの終了まで |

**Judgement**: `model`、`verdict`（`pass` / `fail` / `none`=判定できない）、`error?`、`comparable`（R6 の分母に入るか）、`calls`・`inputTokens`・`outputTokens`・`latencyMs`（その工程名の `llm_calls` の合計）

**状態の決まり方**:

```
準備に失敗 / 予期しない例外 → error
工程の終わり方が passed 以外 → failed (failure=pipeline)。ただし budget_exceeded・aborted で評価が止まる場合も failed として残す
隠しチェックが unavailable → error
passed かつ 隠しチェック passed → succeeded
passed かつ 隠しチェック failed → failed (failure=grader)
上限・予算・中断でまだ始めていない → not_run
```

## 3. 評価の実行（EvalRun。結果のファイル）

形の詳細は [contracts/result-file.md](./contracts/result-file.md)。

| 項目 | 型 | 説明 |
|---|---|---|
| version | 1 | ファイルの形の版 |
| runId | string | `<開始時刻 YYYYMMDDTHHmmssZ>-<setName>` |
| setName | string | セットのディレクトリ名 |
| startedAt / finishedAt | string | ISO 8601（UTC） |
| harness | object | `commit`・`dirty` |
| provider | string | `[llm].provider` |
| models | object | `planner`・`implementer`・`verifier`・`verifier_alt?` |
| options | object | `cases`（絞り込み）・`repeat`・`maxRequests` |
| stopped | `max_requests` / `budget_exceeded` / `aborted` / undefined | |
| cases | CaseResult[] | |
| summary | Summary | 下記 |

**Summary**: `executed`（succeeded＋failed）・`succeeded`・`failed`・`errors`・`notRun`・`successRate`（executed=0 なら null）・`byWorkType`（作業の種類 → executed・succeeded・successRate）・`requests`（合計）・`avgRequests`・`avgDurationMs`（executed の平均）・`verifiers`（VerifierStats の配列。主と比較用）

**VerifierStats**: `label`（`verifier` / `verifier_alt`）・`model`・`comparable`（分母）・`correct`・`falsePass`（隠しチェック失敗なのに pass）・`falseFail`（隠しチェック成功なのに fail）・`undecided`（判定できない）・`accuracy`（comparable=0 なら null）・`avgInputTokens`・`avgOutputTokens`・`avgLatencyMs`（1回の LLM 呼び出しあたり）

## 4. 比較（Comparison）

| 項目 | 説明 |
|---|---|
| baseline / current | runId と開始時刻 |
| common | 両方で executed になった (caseId, attempt) の数 |
| metrics | 共通の集合での successRate・avgRequests・avgDurationMs の before / after / delta |
| regressions | 前回 succeeded → 今回 failed/error（caseId・attempt・今回の reason） |
| improvements | 前回 failed/error → 今回 succeeded |
| onlyInBaseline / onlyInCurrent | 片方でしか実行されていない (caseId, attempt)（not_run を含む） |
| changedCases | caseHash が違うケース |
| configDiff | models・provider・harness.commit の違い（項目名・前・後） |

## 5. 評価用のジョブ（既存の `jobs`）

`repo = "eval:<setName>/<caseId>"`、`issue_number = 0`、`trigger_comment_id = <開始時刻のミリ秒 + 連番>`（一意制約のため）、`requested_by = "eval"`、`instruction = <ケースの instruction か "eval">`、`status = "planning"`。評価は状態を進めない（005 の CLI と同じ扱い）。
