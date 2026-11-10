# Data Model: 実装役とハーネス（implementer-agent）

## 1. SQLite: `agent_runs`（新しい表）

実装工程（と、005 以降でツールを使う工程）の実行1回ごとの要約。1件1行。詳細は軌跡のファイル（2章）に置く。

| 列 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | integer | PK, autoincrement | 軌跡の各行の `run` |
| `job_id` | integer | NOT NULL, FK → `jobs.id` | |
| `phase` | text | NOT NULL | 工程（本機能は `implement`）。工程は増えるので CHECK を付けない（`llm_calls.phase` と同じ） |
| `attempt` | integer | NOT NULL, `>= 1` | 同じジョブ・同じ工程の何回目か。`(job_id, phase)` の既存の行数 + 1 |
| `model` | text | NOT NULL | 実装役のモデル名 |
| `outcome` | text | NULL のとき実行中。CHECK（下の一覧） | 終わり方 |
| `turns` | integer | NOT NULL, default 0 | LLM の応答を受けたターン数 |
| `requests` | integer | NOT NULL, default 0 | この実行で増えた `llm_calls` の行数（リトライを含む） |
| `tool_calls` | integer | NOT NULL, default 0 | 実行したツールの呼び出し回数（拒否を含まない） |
| `blocked_calls` | integer | NOT NULL, default 0 | 検査で拒否した回数 |
| `compactions` | integer | NOT NULL, default 0 | 圧縮が効いた LLM 呼び出しの回数 |
| `steers` | integer | NOT NULL, default 0 | 差し込んだメッセージの数 |
| `error` | text | | 失敗の原因（マスク済み）。`failed`・`budget_exceeded` のとき |
| `trace_path` | text | NOT NULL | 軌跡のファイルの場所（`storage.trace_dir` からの相対パス） |
| `started_at` | integer | NOT NULL | UTC の Unix ミリ秒 |
| `finished_at` | integer | | |

- **outcome の値**: `completed` / `max_turns` / `timeout` / `budget_exceeded` / `blocked_repeatedly` / `aborted` / `failed`
- **索引**: `(job_id, phase, attempt)` に UNIQUE
- **マイグレーション**: `drizzle/0002_agent_runs.sql`（`pnpm run db:generate` で作る）
- **書くタイミング**: 開始時に INSERT（`outcome = NULL`）、終了時に UPDATE。ファクトリーが途中で落ちた行は `outcome = NULL` のまま残る（007 の起動時の後始末で `failed` にする。本機能では扱わない）

## 2. 軌跡のファイル: `<trace_dir>/job-<jobId>.jsonl`

1行1件の JSON。文字列の値はすべて書く前にマスクする（`maskSecrets` ＋ APIキーの文字列そのもの）。

### 共通の項目

| 項目 | 型 | 説明 |
|---|---|---|
| `ts` | number | UTC の Unix ミリ秒 |
| `run` | number | `agent_runs.id` |
| `phase` | string | `implement` |
| `attempt` | number | `agent_runs.attempt` |
| `seq` | number | 実行の中での通し番号（0 始まり） |
| `type` | string | 下の種類 |

### 種類ごとの項目

| `type` | 項目 | 説明 |
|---|---|---|
| `run_start` | `model`, `systemPrompt`, `initialMessage`（最初の user メッセージの本文）, `limits`（`maxTurns`, `deadline`, `maxConsecutiveBlocks`, `compactionRatio`, `keepRecentTurns`, `contextWindow`）, `truncated`（切り詰めた部分の名前の一覧） | 開始。ここにある2つの文字列が入力の土台 |
| `request` | `turn`（1 始まり）, `estimatedTokens`（圧縮前）, `compactedToolCallIds`（この呼び出しで注記に置き換えた一覧。なければ空）, `estimatedTokensAfter` | LLM 呼び出しの直前。`transformContext` の中で書く |
| `message` | `message`（Pi のメッセージをそのまま。`role` は `user` / `assistant` / `toolResult` / `system`） | 会話に増えたメッセージ1つ。最初の user メッセージは `run_start` にあるので書かない |
| `tool_blocked` | `toolCallId`, `toolName`, `guard`, `reason` | 検査で拒否した。続く `message`（toolResult）にも理由が入る |
| `tool_result_meta` | `toolCallId`, `toolName`, `originalChars`, `details` | 整形の前の文字数と、ツールの記録用の詳細（終了コード・所要時間・打ち切りなど） |
| `steer` | `text`, `accepted` | 差し込み。`accepted = false` は工程の終了後で受け付けなかったもの |
| `note` | `message` | 補足（圧縮に失敗したときなど） |
| `run_end` | `outcome`, `turns`, `requests`, `toolCalls`, `blockedCalls`, `compactions`, `steers`, `lastMessage`, `truncatedOutput`, `error` | 終了 |

### 入力の復元（`trace/replay.ts`）

ある実行の `n` ターン目の LLM への入力:

1. `run_start.systemPrompt` をシステムの指示、`run_start.initialMessage` を最初の user メッセージにする
2. `seq` の順に、`n` ターン目の `request` より前の `message` を足す
3. その `request.compactedToolCallIds` にある toolResult を、R4 の注記（同じ関数で作る）に置き換える

`message` は Pi のメッセージをマスクして書くので、復元した入力は「マスク後の入力」になる。テストではマスクの対象を含まない入力で一致を確かめ、マスクは別のテストで確かめる。

## 3. 入口と結果（Pi に依存しない型）

`contracts/module-api.md` に型を書く。ここでは関係だけを示す。

```
ImplementerInput ──startImplementer──▶ ImplementerRun ──result──▶ ImplementerResult
  jobId                                  steer(text) → boolean      outcome
  workspace（tools・guard・transform・readAgentsMd）  abort()        lastMessage, truncatedOutput
  issue, plan, feedback[]                                            turns, requests, toolCalls, blockedCalls
  deadline, maxTurns?, signal?                                       error?, runId, tracePath
```

### 状態の移り変わり（実行1回）

```
started ──(LLM 応答・ツール…)──▶ running ──▶ 終わり方のどれか（R12 の順で決める）
             │
             └─ steer() は running の間だけ true。終わり方が決まったあとは false
```

## 4. 設定の追加: `[implementer]`

`contracts/factory-toml.md` を参照。

| 項目 | 既定 | 範囲 |
|---|---|---|
| `max_consecutive_blocks` | 5 | 1〜50 |
| `compaction_ratio` | 0.7 | 0.3〜0.95 |
| `keep_recent_turns` | 4 | 1〜20 |
| `max_agents_md_chars` | 20000 | 1000〜200000 |
| `max_issue_chars` | 20000 | 1000〜200000 |
| `max_plan_chars` | 20000 | 1000〜200000 |
| `max_feedback_chars` | 30000 | 1000〜200000 |
