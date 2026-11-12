# Data Model: 計画・工程内テスト・判定（local-pipeline）

## 1. SQLite: `agent_runs` に列を1つ足す（マイグレーション `0003`）

| 列 | 型 | 内容 |
|---|---|---|
| `verdict` | text NULL、CHECK `verdict IN ('pass','fail')` | 判定（`phase = 'judge'`）の合否。判定以外の工程と、判定できなかった回は NULL |

`agent_runs` の使い方（004 の表を使い回す。research R9）:

| `phase` | 1行の単位 | `turns` | `requests` | `tool_calls` | `outcome` |
|---|---|---|---|---|---|
| `implement` | 実装工程1回（004 のまま） | ターン数 | 増分 | 回数 | 004 のまま |
| `plan` | 計画役の1回（再要求を含む） | 呼び出し回数（1〜2） | 増分 | 0 | `completed`（計画を得た）・`failed`（形が合わない／LLM の失敗）・`budget_exceeded`・`timeout`・`aborted` |
| `judge` | 検査役の1回（再要求を含む） | 呼び出し回数（1〜2） | 増分 | 0 | 同上。`completed` のときだけ `verdict` が入る |

- `attempt` は 004 と同じく、同じジョブ・同じ工程の何回目か。判定の `attempt` はやり直しの回（round）と一致しない場合がある（テスト失敗の回は判定をしない）。対応は軌跡の `round_end` で取る
- `llm_calls` の `phase` は `plan`・`implement`・`judge`、`role` は `planner`・`implementer`・`verifier`

## 2. 軌跡（JSONL）に足す行の種類

ジョブごとのファイル `job-<jobId>.jsonl`（004）に追記する。共通の項目（`ts`・`run`・`phase`・`attempt`・`seq`）は 004 のまま。

### 1回呼び出し（`run` は `agent_runs.id`、`phase` は `plan`／`judge`）

| `type` | 中身 |
|---|---|
| `llm_request` | `model`、`systemPrompt`、`messages`（この呼び出しで渡した user／assistant メッセージの本文。1回目は user 1件、再要求では前回の出力と再要求の文が増えた分だけ）、`truncated`（切り詰めた部分の名前） |
| `message` | 応答の assistant メッセージ（004 と同じ形） |
| `validation` | `ok`、`errors`（「パス: 理由」の一覧）、`extracted`（JSON を取り出せたか） |
| `run_end` | 004 と同じ形（`toolCalls`・`blockedCalls`・`compactions`・`steers` は 0）。`verdict` を足す（判定のとき） |

### 工程全体（`run = 0`、`phase = "pipeline"`、`attempt = 0`）

| `type` | 中身 |
|---|---|
| `pipeline_start` | `deadline`、`judgeRetries`、`checkCommands`、`maxCheckFeedbacks`、`planGiven`（計画を渡されたか）、`baseCommit` |
| `phase` | `name`（`planning`・`implementing`・`testing`・`judging`）、`round` |
| `check_run` | `round`、`index`（その回の何回目のテストか）、`results`: `[{ command, exitCode, durationMs, timedOut, outputChars, output }]`（`output` はマスク・切り詰め後）、`passed`、`fedBack`（実装役に差し込んだか） |
| `round_end` | `round`、`implementOutcome`、`checks`（`passed`・`failed`・`skipped`・`not_run`）、`diffStat`（`files`・`insertions`・`deletions`）、`verdict`（`pass`・`fail`・`not_judged`）、`reason`（不合格の理由の種類: `judge_failed`・`checks_failed`・`no_changes`・`max_turns`・`blocked_repeatedly`）、`next`（`retry`・`finish`） |
| `pipeline_end` | `outcome`、`rounds`、`requests`、`error` |

- 004 の `replayRequests` は `run_start` のある run だけを対象にするので、`run = 0` と1回呼び出しの行は影響しない。1回呼び出しの入力の復元は `llm_request` を順につなぐ（`replayCompletion`）

## 3. 工程の型（`src/pipeline/run.ts`。Pi の型を含まない）

### PipelineInput

| 項目 | 型 | 内容 |
|---|---|---|
| `jobId` | number | 予算ゲートと記録 |
| `workspace` | `Workspace` | 004 の作業場（4ツール・検査・整形・AGENTS.md）＋ `exec`（R5） |
| `workdir` | string | ホストの作業ディレクトリ（diff・ファイル一覧の取り出し） |
| `issue` | `{ title, body }` | |
| `instruction` | string（任意） | 依頼の本文（`@agent` のあと） |
| `plan` | string（任意） | 渡されたら計画役を飛ばす（CLI の `--plan`） |
| `deadline` | number | UTC の Unix ミリ秒 |
| `signal` | AbortSignal（任意） | 呼び出し側の中断 |
| `onPhase` | `(phase, round) => void`（任意） | 工程の境目。例外は握りつぶしてログに残す |

### PipelineResult

| 項目 | 型 | 内容 |
|---|---|---|
| `outcome` | `passed \| rejected \| failed \| budget_exceeded \| timeout \| aborted` | |
| `plan` | `Plan \| undefined` | 計画役の出力（渡された計画なら `undefined`） |
| `planText` | string | 実装役・検査役に渡した計画の文章 |
| `verdict` | `Verdict \| undefined` | 最後の判定 |
| `reason` | string | 最後の不合格・失敗の理由（報告に使う。マスク済み） |
| `rounds` | `RoundSummary[]` | 各回の要約 |
| `retries` | number | やり直しの回数（`rounds.length - 1`） |
| `requests` | number | ジョブ内の `llm_calls` の増分 |
| `diff` | string | 最後の diff（マスクしない。008 の出荷前チェック〔gitleaks〕に使う。表示・記録するときは呼び出し側がマスクする） |
| `diffStat` | `{ files, insertions, deletions }` | |
| `error` | string（任意） | `failed` などの原因（マスク済み） |
| `tracePath` | string | 軌跡のファイル |

### Plan（計画役の出力。TypeBox で検証）

| 項目 | 型 | 制約 |
|---|---|---|
| `summary` | string | 1文字以上 |
| `steps` | string[] | 1件以上、各1文字以上 |
| `acceptance_criteria` | string[] | 1件以上、各1文字以上 |
| `work_type` | string | `bugfix`・`test`・`docs`・`refactor`・`feature`・`chore` のどれか |

余分な項目は許し、捨てる。

### Verdict（検査役の出力。TypeBox で検証）

| 項目 | 型 | 制約 |
|---|---|---|
| `verdict` | string | `pass`・`fail` のどちらか |
| `reasons` | string | 1文字以上 |
| `criteria` | `{ criterion: string, met: boolean, note?: string }[]` | 0件以上 |
| `fixes` | string[]（任意） | 不合格のときの直すべき点 |

合否は `verdict` の値だけで決める（Edge Cases）。

### RoundSummary

| 項目 | 内容 |
|---|---|
| `round` | 1 始まり |
| `implement` | 実装工程の `outcome`・`turns`・`requests`・`runId` |
| `checks` | `status`（`passed`・`failed`・`skipped`〔コマンドなし〕・`not_run`〔実装工程が完了しなかった〕）、`runs`（工程内テストを実行した回数）、`fedBack`（差し込んだ回数） |
| `verdict` | `pass`・`fail`・`not_judged` |
| `reason` | 不合格の理由の種類（2章の `round_end.reason`） |
| `diffStat` | その回の終わりの diff の数 |

## 4. 終わり方の決め方

| 状況 | 結果 |
|---|---|
| 判定が合格 | `passed` |
| やり直しを使い切って不合格 | `rejected` |
| 計画・判定の出力が2回とも形に合わない／実装工程が `failed`／テストのコマンドを起動できない（126・127・作業場の異常）／軌跡に書けない／検査役と実装役が同じモデル／Issue と依頼が空 | `failed` |
| 予算ゲートが止めた（どの工程でも） | `budget_exceeded` |
| 期限を過ぎた | `timeout` |
| 呼び出し側が中断した | `aborted` |

007 の `PipelineOutcome` への対応（007 の plan で合わせる）: `passed` → `verdict: "pass"`、`rejected` → `verdict: "fail"`（報告して終了）、`failed` → `failureKind: "pipeline_failed"`、`budget_exceeded`・`timeout` → 同名の `failureKind`、`aborted` → 007 の停止の扱い。

## 5. 設定 `[pipeline]`

[contracts/factory-toml.md](./contracts/factory-toml.md) を参照。
