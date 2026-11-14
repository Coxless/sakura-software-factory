---

description: "Task list for 009 ci-feedback"
---

# Tasks: CI連携（ci-feedback）

**Input**: Design documents from `specs/009-ci-feedback/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。FR-029 と SC-001〜SC-008 が自動テストでの確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。

**Organization**: ユーザーストーリーごとにまとめる。US1〜US3 はどれも P1。US1（受付と見回り）が US2（やり直し）と US3（時間切れ）の土台なので US1 → US2 → US3 の順に置く。US4（設定）は P2 だが、設定の項目は Phase 1 で先に足す。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US4）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- `octokit` を import してよいのは `src/github/` の中だけ。ほかの層は `GitHubPort` だけを使う（原則 VII）
- テストで GitHub の API と LLM を呼ばない
- テストで使う本物の形の偽のトークンは、テストの中で乱数から組み立てる
- 想定と違う挙動・エラーに当たったら `docs/journal/2026-11-14-009-ci-feedback-実装.md` に記録する

---

## Phase 1: Setup

- [ ] T001 `src/config.test.ts` に contracts/factory-toml.md のテストを足す: 省略時に `worker.ci_check_interval_seconds = 60`・`pipeline.max_ci_log_chars = 12000`。範囲の外（`ci_check_interval_seconds` が 9・3601、`max_ci_log_chars` が 999・100001）で項目の名前を含むエラー
- [ ] T002 `src/config.ts` に `[worker].ci_check_interval_seconds`（`Range(10, 3600, 60)`）と `[pipeline].max_ci_log_chars`（`Range(1000, 100000, 12000)`）を足して T001 を通し、`factory.toml`・`factory.dev.toml` に日本語のコメント付きで足す。`specs/001-foundation/contracts/factory-toml.md` の「後続の機能で足した表」に 009 のリンクを足す

---

## Phase 2: Foundational（スキーマ・GitHub 層・キュー・失敗の分類）

- [ ] T003 `src/queue/schema.ts` の `jobs` に data-model.md 1章の列を足す: `base_sha` TEXT NULL、`head_sha` TEXT NULL、`ci_status` TEXT NULL（`CI_STATUSES = ["pending", "passed", "failed"]`、CHECK `ci_status IN ('pending', 'passed', 'failed')`）、`ci_deadline` INTEGER NULL、`ci_event_at` INTEGER NULL、索引 `jobs_status_ci_status_idx(status, ci_status)`。`pnpm exec drizzle-kit generate --name ci_feedback` で `drizzle/0004_ci_feedback.sql` を作り、`src/queue/schema.test.ts` に CHECK（不正な `ci_status` を拒む）のテストを足す
- [ ] T004 [P] `src/github/port.ts` に contracts/module-api.md の `getPullRequest`・`getCheckRuns`・`getCheckRunLog` と data-model.md 5章の `PullRequestState`・`CheckRunInfo`・`CiEvent` を足し、`src/github/testing.ts` の偽の GitHub に同じ操作を足す（`checkRuns`（sha → 一覧）・`checkLogs`（id → 文）を持たせ、PR に `state`・`merged`・`headSha` を持ち、`mergePullRequest(number)`・`closePullRequest(number)`・`setCheckRuns(sha, runs)` で状態を変えられる）
- [ ] T005 [P] `src/github/client.ts` に本物の `getPullRequest`（`GET /repos/{o}/{r}/pulls/{n}`、`auto_merge` が null でなければ `autoMerge: true`）・`getCheckRuns`（`octokit.paginate` で `GET /repos/{o}/{r}/commits/{sha}/check-runs`、`filter: "latest"`、`per_page: 100`）・`getCheckRunLog`（`app.slug == "github-actions"` なら `GET /repos/{o}/{r}/actions/jobs/{id}/logs`、取れなければ `GET /repos/{o}/{r}/check-runs/{id}` の `output.title`・`summary`・`text` を改行でつなぐ。どれもなければ・例外なら `undefined`）を足す
- [ ] T006 `src/queue/jobs.test.ts` に contracts/module-api.md の `claimNextJob`・`noteCiEvent`・`listCiJobsToCheck`・`markPendingCiJobs` のテストを先に書く: やり直しを待つ（`ci_waiting`・`ci_status = 'failed'`）ジョブが queued より先に `implementing` になり、`ci_retries` が1増え、`ci_status`・`ci_deadline` が NULL、`state_changed` の detail に `reason: "ci_retry"`。なければ queued を planning。`noteCiEvent` は check_suite で branch と head_sha が一致する `ci_waiting` だけ、pull_request_closed で pr_number が一致する `ci_waiting` だけに `ci_event_at` を入れ `ci_event` を記録する。`listCiJobsToCheck` は `ci_event_at` あり、または `ci_status = 'pending'` で `ci_deadline <= now` を古い順に返し、`passed` で期限切れのものは返さない
- [ ] T007 `src/queue/jobs.ts` に T006 の関数を実装する（即時トランザクション、条件付きの UPDATE … RETURNING）。`INTERRUPTIBLE_STATUSES` の説明のコメントを「`ci_waiting` は 009 の見回りで扱う」に直す
- [ ] T008 [P] `src/pipeline/state.ts` の `TransitionFields` に `base_sha`・`head_sha`・`ci_status`・`ci_deadline`・`ci_event_at` を足す
- [ ] T009 `src/pipeline/report.ts` の `FAILURE_KINDS` に `ci_failed`・`ci_timeout`・`ci_unfixed`・`pr_closed` と `describeKind` の文（contracts/report.md 2章）を足し、`renderFailureReport` に PR の行（`pr_number` があるとき）・CI のやり直しの行（`ci_retries / 上限`）・失敗したチェック（`failedChecks`、最大 10 件）を足す。`src/pipeline/report.test.ts` に文面のテストを足す

**Checkpoint**: スキーマ・GitHub 層・キューが揃う。007・008 の既存のテストが通ること

---

## Phase 3: User Story 1 - CI の結果を受けて、待っているジョブを先へ進める (Priority: P1) 🎯 MVP

**Goal**: `check_suite`・`pull_request` を受け、見回りが CI の結論・マージ・クローズを判断して PR の本文に書き足す

**Independent Test**: 偽の GitHub に CI の結果を持たせ、署名付きの知らせを受付に送り、見回りで状態・記録・PR の本文を確かめる

### Tests for User Story 1

- [ ] T010 [P] [US1] `src/github/events.test.ts` に `toCiEvent` のテストを書く: `check_suite` completed → `{ kind: "check_suite", repo, headBranch, headSha }`、requested → ignored（action）、`pull_request` closed（merged true/false）→ `pull_request_closed`、opened → ignored、項目の欠け → `PayloadError`、ほかのイベント → ignored（event）。フィクスチャを `src/github/fixtures/check_suite.completed.json`・`pull_request.closed.merged.json` に置く
- [ ] T011 [P] [US1] `src/pipeline/ci.test.ts` に `concludeCi` のテストを書く（research R1）: 0件 → pending、途中あり → pending、success・neutral・skipped だけ → success、failure・timed_out・cancelled・action_required・startup_failure・stale のどれか → failure（失敗したものの名前と終わり方）
- [ ] T012 [P] [US1] `src/pipeline/ci.test.ts` に `checkCiJob` と CI の欄のテストを書く: 全部成功 → `ci_status = 'passed'`・`ci_result`（`attempt = ci_retries + 1`）・PR の本文の CI の欄に「✅ 通過」、状態は `ci_waiting` のまま。片方だけ完了 → pending、記録なし。PR がマージ済み → `ci_waiting` → `merged`・`merged` の記録・欄に「🎉 マージ」。マージされずに閉じた → `failed`（`pr_closed`）・Issue に1回報告・Draft への変更を呼ばない。同じジョブを2回評価しても `ci_result` と Issue の報告は1回。PR の本文の欄の外（008 のまとめ）は変わらない。本文の更新の失敗は `ci_body_failed` に残り、状態は進む。`ci_result` の `attempt` を SQL（`json_extract`）で引いて CI 初回通過を集計できる（SC-008）
- [ ] T013 [P] [US1] `src/http/webhook.test.ts` に contracts/webhook.md のテストを書く: 結び付く `check_suite` → `202 ci_noted`・`ci_event_at` が入る・見回りの起こしが呼ばれる・GitHub の API を呼ばない。head_sha が違う・ブランチがない → `202 ignored`。`pull_request` closed で pr_number が一致 → `ci_noted`。項目の欠け → `400`。署名が違う → `401`（CI のイベントでも）

### Implementation for User Story 1

- [ ] T014 [US1] `src/github/events.ts` に `toCiEvent` を実装する（TypeBox で必要な項目だけを検証、余分な項目は許す）。T010 を通す
- [ ] T015 [US1] `src/pipeline/report.ts` に `renderCiSection(events)`・`replaceCiSection(body, section)` を足し（contracts/report.md 1章。印は `<!-- factory:ci -->`・`<!-- /factory:ci -->`、記録がなければ「CI の結果を待っています」）、`renderShipReport` の末尾の印を空の CI の欄に置き換える。008 の `report.test.ts` の該当の期待を直す
- [ ] T016 [US1] `src/pipeline/ci.ts` に `concludeCi`・`checkCiJob`・`refreshCiSection`・`createCiMonitor` を実装する（research R3。評価の前に読んだ `ci_event_at` を `WHERE ci_event_at = <値>` で消す、`ci_status` の更新は `status = 'ci_waiting' AND ci_status = 'pending' AND head_sha = <評価した commit>` の条件付き、記録と本文は更新が1行を変えたときだけ。起動時に `markPendingCiJobs`。ループは `wake` で待ちを打ち切り、`stop` は評価中の1件を待つ）。T011・T012 を通す（失敗の扱いは US2・US3 で足すので、ここでは failure を `ci_status = 'failed'` にするだけ）
- [ ] T017 [US1] `src/http/webhook.ts` で `X-GitHub-Event` が `check_suite`・`pull_request` のとき `toCiEvent` → `noteCiEvent` → 応答のあと `wakeCi()`（`WebhookDeps` に `wakeCi?: () => void` を足す）にする。T013 を通す
- [ ] T018 [US1] `src/pipeline/ship.ts` の最初の出荷で、`transitionPath` の fields に `base_sha`（commit の親）・`head_sha`・`ci_status: "pending"`・`ci_deadline: now + ci_wait_timeout_minutes` を足し、`shipped` の記録に `plan`・`plan_text` を足す（research R10・R11）。`src/pipeline/ship.test.ts` に期待を足す
- [ ] T019 [US1] `src/main.ts` で起動時の掃除のあとに `createCiMonitor`（`wakeWorker` は Worker の `wake`）を作って `start()` し、受付に `wakeCi` を渡し、停止を Worker → 見回り → HTTP の順にする。`src/main.test.ts` に起動・停止のテストを足す

**Checkpoint**: CI が通ったジョブが PR の本文に書き足され、マージで `merged` になる

---

## Phase 4: User Story 2 - CI の失敗をログ付きで実装役に戻して直す (Priority: P1)

**Goal**: CI の失敗で、ログと前回の diff を付けて実装工程をやり直し、同じ PR に追加の push をする

**Independent Test**: 偽の GitHub に失敗した CI とログを持たせ、偽の 005 の入口で、渡されたフィードバック・追加の push・状態の移り変わりを確かめる

### Tests for User Story 2

- [ ] T020 [P] [US2] `src/pipeline/ci-log.test.ts` に `truncateCiLog`・`ciFeedback` のテストを書く（research R8、contracts/report.md 3章）: 行の先頭の時刻と ANSI の色が消える、`##[error]` の行の前 20 行・後 10 行が残り間が `…（N 行省略）…`、`##[error]` がなければ `error`・`FAIL` などの行、どれもなければ末尾 200 行、上限以内、本物の形のトークンが伏せ字。`ciFeedback` は title の順（CI の失敗 → 前回の diff）、`<ci_log name=… conclusion=…>`、ログなしは「（ログを取れませんでした）」、6 件目以降は名前だけ、合計が `max_ci_log_chars` 以内
- [ ] T021 [P] [US2] `src/github/git.test.ts` に `cloneBranchForRetry` のテストを書く（ローカルの bare リポジトリ）: 作業ブランチの先頭が HEAD、`base_sha` がない履歴なら `CloneError`、トークンが引数・`.git/config`・リモートの URL に現れない
- [ ] T022 [P] [US2] `src/pipeline/run.test.ts` に `PipelineInput` の追加のテストを書く（data-model.md 6章）: `plan`＋`planObject` で計画役を呼ばず結果の `plan` に入る、`baseCommit` で diff の基準が変わる、`initialFeedback` が1回目の実装役の入力に入り2回目には入らない、`preflightChecks` で実装の前に工程内テストが1回走り、通ったら「再現しません」、失敗したら「工程内テストでも失敗します」が入力に入る
- [ ] T023 [P] [US2] `src/pipeline/ship.test.ts` に更新の形のテストを書く（research R11）: 追加の commit が作業ブランチに早送りで push され PR は作られない、出荷前チェックの diff の大きさが PR の変更全体、auto-merge の PR が条件を外れたら Draft、Draft は Draft のまま、変更なしで `failed`（`ci_unfixed`）・push なし、PR が閉じていれば `failed`（`pr_closed`）・push なし、状態が `judging` → `pr_opened` → `ci_waiting` で `head_sha`・`ci_status = 'pending'`・`ci_deadline` が新しくなる、`ci_retry_pushed` の記録、Issue にコメントしない
- [ ] T024 [P] [US2] `src/pipeline/worker.test.ts` にやり直しのテストを書く: やり直しを先に取り出す、005 の入口に `plan`・`planObject`・`baseCommit`・`initialFeedback`（失敗したチェックの名前とログ）・`preflightChecks: true` が渡る、期限が取り出した時刻 ＋ `job_timeout_minutes`、合格で同じ PR に追加の push、不合格で `failed`（`judge_rejected`）と PR の Draft への変更、計画の記録がなければ `internal_error`
- [ ] T025 [P] [US2] `src/pipeline/ci.test.ts` に失敗の扱いのテストを足す: 上限未満 → `ci_status = 'failed'`・Worker の起こし・欄に「❌ 失敗」、上限（`ci_retries` が上限と同じ）→ `failed`（`ci_failed`）・Issue に失敗したチェックの名前・PR を Draft・欄に「🛑」、`ci_retries = 0` の設定で1回目の失敗から `failed`
- [ ] T026 [P] [US2] `src/pipeline/report.test.ts` に `failJob` の引き渡しのテストを足す（research R13）: `pr_number` のあるジョブは報告のあとに Draft へ変え `ci_gave_up` を記録し欄を書き直す、すでに Draft なら変えない、`pr_closed` では変えない、Draft でも auto-merge でもない PR（008 の `unsettled`）も Draft に変える、Draft への変更の失敗は `handover_failed` でジョブは `failed`

### Implementation for User Story 2

- [ ] T027 [US2] `src/pipeline/ci-log.ts` に `truncateCiLog`・`ciFeedback` を実装し、`src/harness/context.ts` の `DATA_TAGS` に `ci_log` を足す。T020 を通す
- [ ] T028 [US2] `src/github/git.ts` に `cloneBranchForRetry` を実装する（`clone --quiet --single-branch --branch <branch>`、トークンは環境変数、`cat-file -e <base>^{commit}`）。T021 を通す
- [ ] T029 [US2] `src/pipeline/run.ts` に `planObject`・`baseCommit`・`initialFeedback`・`preflightChecks` を実装する（research R9。軌跡の `check_run` は `round: 0`）。T022 を通す
- [ ] T030 [US2] `src/pipeline/ship.ts` に `update` の形を実装する（research R11）。T023 を通す
- [ ] T031 [US2] `src/pipeline/report.ts` の `failJob` に引き渡しを実装する（research R13）。T026 を通す
- [ ] T032 [US2] `src/pipeline/ci.ts` の失敗の扱い（上限の判断、`failJob(ci_failed, failedChecks)`、`wakeWorker`）を実装する。T025 を通す
- [ ] T033 [US2] `src/pipeline/worker.ts` を `claimNextJob` に替え、`ci_retry` の処理（`cloneBranchForRetry` → インストール → 最新の `shipped` の計画 → `getCheckRuns` と最大 5 件のログ → `ciFeedback`（diff は `gitDiffSource.diff(workdir, base_sha)`）→ 005 の入口 → `shipJob({ update })` か `failJob`）を足す。T024 を通す

**Checkpoint**: CI が落ちたジョブが、ログ付きで直されて同じ PR に追加の push をし、上限で人間に渡される

---

## Phase 5: User Story 3 - CI を待ちすぎたら諦めて人間に渡す (Priority: P1)

**Goal**: CI 待ちの期限で取り直し、結論がなければ `failed`（`ci_timeout`）と Draft。再起動のあとも取り直す

**Independent Test**: 時計を進めて見回りを回し、取り直しの結果ごとの扱いを確かめる

- [ ] T034 [P] [US3] `src/pipeline/ci.test.ts` に時間切れのテストを足す: 期限切れでチェックが途中・0件 → `failed`（`ci_timeout`）・Draft・Issue に1回、期限切れで取り直したら失敗 → 失敗の扱い、通過 → `passed`、`passed` のジョブは期限を過ぎても評価しない、`createCiMonitor` の `start` で `pending` のジョブに `ci_event_at` が入る（起動時の取り直し）
- [ ] T035 [US3] `src/pipeline/ci.ts` に時間切れの扱いを実装する。T034 を通す
- [ ] T036 [US3] `src/pipeline/worker.test.ts` の起動時の掃除のテストに、`ci_waiting`（`pending`・`passed`・`failed` それぞれ）のジョブが `failed` にならないこと、やり直しの工程の途中（`implementing`、`pr_number` あり）で中断したジョブが `failed`（`restarted`）になり PR が Draft に変わることを足す

**Checkpoint**: `ci_waiting` のジョブが期限 ＋ 見回りの間隔を過ぎて結論なしで残らない

---

## Phase 6: User Story 4 - CI 連携の上限と切り詰めを設定で変える (Priority: P2)

- [ ] T037 [US4] `src/pipeline/ci-log.test.ts`・`src/pipeline/ci.test.ts` に、`max_ci_log_chars` を下げた設定でログが新しい上限以内、`ci_check_interval_seconds` の値で見回りの間隔が変わることを足す（設定の項目は T001・T002 で足し済み）

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T038 設計ドキュメントを直す（plan.md「設計ドキュメントとの差分」）: `docs/design/03_アーキテクチャと技術スタック.md` の3章・4章 #8・#9・5章・8章、`docs/design/04_ガードレールとハーネス設計.md` の3章
- [ ] T039 [P] `deploy/README.md` の GitHub App の設定に、権限 Checks: read・Actions: read とイベント `check_suite`・`pull_request` を足す（`specs/007-github-intake/contracts/github-app.md` も）
- [ ] T040 [P] `docs/journal/2026-11-14-009-ci-feedback-specとplan.md` に、推奨で決めたことと理由、まだ確かめていないことを書く
- [ ] T041 `workshop exec dev -- bash -lc 'cd /project && pnpm run check'` と `pnpm run secrets:scan` を通す（`src/ship-dev.test.ts` を含む）。quickstart.md の自動テストの表のテストがあることを確かめる

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1 → US2 → US3 → US4 → Polish
- US2 は US1 の見回り（`ci.ts`）と最初の出荷の CI の列（T018）に依存する
- US3 は US1・US2 の `ci.ts` に足す
- Phase 2 の T004・T005・T008 は並行できる。T006 → T007 の順

## Parallel Example: User Story 2

```text
T020 ci-log.test.ts / T021 git.test.ts / T022 run.test.ts / T023 ship.test.ts / T024 worker.test.ts / T025 ci.test.ts / T026 report.test.ts
→ T027〜T033（ファイルごとに並行。T033 は T028〜T031 のあと）
```

## Implementation Strategy

- **MVP**: Phase 1・2 と US1。CI が通ったジョブがマージで `merged` になり、PR の本文に CI の結果が書かれる
- 次に US2（ハーネスの効き目を測れる CI のフィードバック）、US3（待ちの上限）。US4 は設定の確認だけ
