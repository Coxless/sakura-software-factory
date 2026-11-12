---

description: "Task list for 007 github-intake"
---

# Tasks: 受付とジョブキュー（github-intake）

**Input**: Design documents from `specs/007-github-intake/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。FR-033 と SC-001〜SC-009 が自動テストでの確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。

**Organization**: ユーザーストーリーごとにまとめる。US1（署名）→ US2（受付）は 005 に依存しないので先に作れる。US4（報告）は US3（Worker）が使うので US3 の前に置く。US3 は 005 の入口を `PipelinePort` の偽物で作り、本物へのつなぎは 005 のマージ後（T034）に行う。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- `octokit`・`@octokit/webhooks` を import してよいのは `src/github/` の中だけ。ほかの層は `GitHubPort` と `AgentRequest` だけを使う（原則 VII）
- テストで GitHub の API と本物の LLM を呼ばない。記録したペイロードは個人情報（実在のアカウント名・メールアドレス）を伏せてから `src/github/fixtures/` に置く
- 想定と違う挙動・エラーに当たったら `docs/journal/<実装した日>-007-github-intake.md` に記録する

---

## Phase 1: Setup

- [ ] T001 octokit と @octokit/webhooks を完全固定で入れる（`pnpm add octokit@5.0.5 @octokit/webhooks@14.2.0`）。`package.json` に `^` `~` がないことを確かめる。`pnpm-workspace.yaml` の `allowBuilds` に新しい推移的な依存のビルドが要るかを確かめ、要らなければ足さない
- [ ] T002 `src/config.test.ts` に追加の項目のテストを足す（contracts/factory-toml.md の表）: 省略時に `github.webhook_max_body_kb = 1024`・`github.max_instruction_chars = 20000`・`worker.poll_interval_seconds = 5`・`storage.work_dir` が設定ファイルの場所を基準にした `data/work` の絶対パス。範囲外（`webhook_max_body_kb` 63・25601、`max_instruction_chars` 99・200001、`poll_interval_seconds` 0・301）がエラー。未知の項目がエラー
- [ ] T003 `src/config.ts` に T002 の項目を足し（`[worker]` はセクションごと省略可、`work_dir` は `database_path` と同じく `resolve(baseDir, ...)`）、`factory.toml`・`factory.dev.toml` に日本語のコメント付きで足す。`specs/001-foundation/contracts/factory-toml.md` の「後続の機能で足した表」に 007 のリンクを足す

## Phase 2: Foundational（状態機械・キュー・GitHub 層の型）

- [ ] T004 [P] `src/pipeline/state.test.ts` を書く: data-model.md の遷移の表のすべての組（12×12）で `canTransition` が表どおり、終わりの状態以外から `failed` へ移れる、`transition` が状態を変えて `job_events` に `state_changed`（`from_status`・`to_status`・`detail`）を1件残す、表にない遷移と現在の状態が `from` でない場合は `StateTransitionError` で状態も記録も変わらない、`failed` に移すと `finished_at` が入る
- [ ] T005 [P] `src/queue/jobs.test.ts` に足す: `enqueueJob` が `queued` で積み `created: true`、同じ `(repo, trigger_comment_id)` で2回呼ぶと2回目は `created: false` で同じジョブを返し件数は1、`markIntakeStopped` がその月の `budget.intake_stopped_at` を1回だけ書く（2回目は時刻を変えない）、`listInterruptedJobs` が `planning`〜`judging` だけを返す（`queued`・`pr_opened`・終わりの状態は返さない）
- [ ] T006 `src/pipeline/state.ts` を作る（T004 を通す）: `TRANSITIONS`（data-model.md の表）、`TERMINAL`、`canTransition`、`StateTransitionError`、`transition(db, jobId, from, to, now, detail?)`（`UPDATE ... WHERE id = ? AND status = ?` と `job_events` の追加を1つのトランザクション。更新が0行なら例外）。`src/queue/schema.ts` の先頭のコメント「遷移のルールは 007 の pipeline/state.ts で決める」はそのまま正しいことを確かめる
- [ ] T007 `src/queue/jobs.ts` に `enqueueJob`・`markIntakeStopped`・`listInterruptedJobs` を足す（T005 を通す。contracts/module-api.md）。`markIntakeStopped` は 002 の `ensureBudgetMonth` を呼んでから `intake_stopped_at IS NULL` のときだけ更新する
- [ ] T008 [P] `src/github/port.ts` に `GitHubPort`・`RepoPermission`・`AgentRequest` の型を置き（contracts/module-api.md）、`src/github/testing.ts` に偽の `GitHubPort`（権限の表・失敗させる操作・呼ばれた操作の記録を持つ）と、署名付きの要求を作る `signedRequest(secret, event, payload, delivery)` を作る

---

## Phase 3: User Story 1 - 正しい Webhook だけを受け取る (Priority: P1) 🎯 MVP

**Goal**: 署名が正しい要求だけを処理し、ほかは中身を読まずに拒否する

**Independent Test**: 署名の4つの場合と大きすぎる本文を送り、応答とジョブの件数を確かめる

- [ ] T009 [P] [US1] `src/github/signature.test.ts` を書く: 正しい秘密 → true、署名なし・`sha256=` の形でない・別の秘密・本文を1バイト変えた → false。比較に `@octokit/webhooks` の検証（定数時間）を使っていることをコードの読みで確かめる旨のコメント
- [ ] T010 [P] [US1] `src/github/fixtures/` に記録したペイロードを置く（GitHub のドキュメントの例をもとに、アカウント名は `octo-requester`・`octo-outsider`・`factory-app[bot]` などの架空の名前にする）: `ping.json`、`issue_comment.created.agent.json`（`@agent` で始まる）、`.created.mention.json`（文中の言及）、`.created.quote.json`（`> @agent`）、`.created.code.json`（コードブロックの中）、`.created.bot.json`、`.created.pull_request.json`、`.created.closed.json`、`.edited.agent.json`、`.created.empty.json`（`@agent` だけ）、`.created.agentx.json`（`@agentx`）
- [ ] T011 [US1] `src/github/signature.ts` を作る（T009 を通す）: `verifySignature(secret, rawBody, header)`
- [ ] T012 [US1] `src/http/webhook.test.ts` の前半を書く（contracts/webhook.md の 1〜4）: 上限を超える本文は `413`（本文を読み切らない。`[github] webhook_max_body_kb` を小さくした設定で）、署名なし・誤りは `401` で偽の GitHub が一度も呼ばれない、署名が正しく JSON が壊れていれば `400`、`ping` は `200 {"result":"pong"}`、応答の本文に内部の情報がない
- [ ] T013 [US1] `src/http/webhook.ts` に `createWebhookHandler(deps)` を作り（`bodyLimit` → 生の本文で `verifySignature` → JSON の解釈 → `ping`）、`src/http/app.ts` の `createApp` に任意の `webhook` を受け取って `POST /webhook` に付ける形を足す（`/healthz` の既存のテストを壊さない）。T012 を通す

**Checkpoint**: 署名のない要求でジョブが作られない（SC-001）

---

## Phase 4: User Story 2 - `@agent` の依頼を確かめてキューに積む (Priority: P1)

**Goal**: 権限のある人の正しい依頼だけを積み、リアクションを付ける。予算切れ・空の依頼は知らせる

**Independent Test**: T010 のペイロードと偽の GitHub（権限・失敗）と予算の残りを変えて、contracts/webhook.md の 5〜10 を確かめる

- [ ] T014 [P] [US2] `src/github/events.test.ts` を書く: `parseAgentCommand` の表（`@agent 直して` → `直して`、`@agent\n続き` → `続き`、先頭の空行は飛ばす、`@agentx`・`@agent-bot`・`> @agent`・行の途中・コードブロックの中 → undefined、`@agent` だけ → 空文字）、`toAgentRequest` が T010 の各ペイロードで contracts/module-api.md の `kind`・`reason` を返す、本文が `max_chars` を超えたら切り詰める、TypeBox でペイロードの必要な項目だけを検証し、欠けていれば `ignored` ではなく例外（`400` にする）
- [ ] T015 [US2] `src/github/events.ts` を作る（T014 を通す）: ペイロードの TypeBox のスキーマ（`action`・`issue.number`・`issue.title`・`issue.body`・`issue.state`・`issue.pull_request`・`comment.id`・`comment.body`・`comment.user.login`・`comment.user.type`・`comment.performed_via_github_app`・`repository.full_name`）、`parseAgentCommand`、`toAgentRequest`
- [ ] T016 [US2] `src/http/webhook.test.ts` の後半を書く（contracts/webhook.md の 5〜10）: 対象でないペイロードは `202 ignored` でジョブ 0、権限 `write`／`maintain`／`admin` かつ許可ユーザー（大文字と小文字を区別しない）で `202 queued` とジョブ1件・`eyes` のリアクション1回、`read`・`triage`・許可ユーザーでない人は `202 ignored` でジョブ 0・コメント 0、権限の確認が例外か 5 秒を超えたら `500` でジョブ 0、空の依頼は `202 usage` で使い方のコメント1回、予算の残りが不足なら `202 budget_exhausted`・`intake_stopped_at` が入り・コメント1回、同じ配送を2回で `duplicate` とジョブ1件・リアクション1回、リアクションが失敗してもジョブは残り `job_events` に `reaction_failed`、DB に書けなければ `500`、積んだら `wake` が1回呼ばれる。応答が 1 秒以内（偽の GitHub、SC-004）
- [ ] T017 [US2] `src/http/webhook.ts` に受付の流れを足す（T016 を通す。research R6）: 判定 → 権限（`AbortSignal.timeout(5000)`）→ 予算（`canAcceptNewJob`）→ `enqueueJob` → 応答。リアクション・コメント・`wake` は応答を返したあとに行う（`queueMicrotask` などで応答を待たせない。失敗はログと `job_events`）。ログには配送の ID と結果を `info` で出し、依頼の本文は出さない
- [ ] T018 [US2] `src/github/client.ts` に本物の `GitHubPort` を作る（octokit の `App`。`getPermission` は `GET /repos/{owner}/{repo}/collaborators/{username}/permission`、`addReaction`、`createIssueComment`、`getCloneAccess` は `GET /repos/{owner}/{repo}` の `default_branch` とインストールトークン。インストールは `GET /repos/{owner}/{repo}/installation` で引いてプロセスの中で覚える）。単体テストは書かず（GitHub を呼ぶため）、型と T008 の偽物と同じ振る舞いになることをコメントで示す。秘密鍵は `GITHUB_APP_PRIVATE_KEY_PATH` のファイルから読む

**Checkpoint**: 記録したペイロードで、正しい依頼だけが積まれる（SC-002・SC-003）

---

## Phase 5: User Story 4 - 失敗したら Issue に1回だけ報告する (Priority: P1)

**Goal**: どこで失敗しても、秘密情報を伏せた報告が Issue にちょうど1回付く

**Independent Test**: `failJob` を各分類で呼び、偽の GitHub に付いたコメントの回数・項目・伏せ字を確かめる

- [ ] T019 [P] [US4] `src/pipeline/report.test.ts` を書く: contracts/report.md の文面（分類ごとの説明、止まった工程、消費したリクエスト数〔`llm_calls` に行を足して数える〕、作業ブランチ、`shipping_not_available` の詳細）、詳細は 2000 文字で切り詰める、`ghp_` のトークンと PEM の見出しが伏せ字になる、`failJob` を2回呼んでもコメントは1回で、`job_events` に `report_posted` が1件、投稿が失敗したらジョブは `failed` のまま `job_events` に `report_failed` が残り例外を投げない、`failed` になって `failure_reason` が `<分類>: <説明>` の形、終わりの状態のジョブには何もしない、作業ブランチがないときは「なし」と表示する（SC-005・SC-006）
- [ ] T020 [US4] `src/pipeline/report.ts` を作る（T019 を通す）: `renderFailureReport`・`renderUsage`・`renderBudgetExhausted`（contracts/report.md）と、`src/pipeline/worker.ts` から使う `failJob`（状態を `failed` にする遷移 → 報告済みかの確認 → `maskSecrets` → 投稿 → 記録）。T017 の使い方・予算切れのコメントもこの関数で本文を作るように直す

---

## Phase 6: User Story 3 - Worker がジョブを1件ずつ処理する (Priority: P1)

**Goal**: 積まれたジョブを1件ずつ、取得 → 作業ブランチ → インストール → 005 の入口 → 報告 → 片付け の順に処理する

**Independent Test**: ローカルの bare リポジトリと偽の 005 の入口で、quickstart.md の1章の worker のテスト

- [ ] T021 [P] [US3] `src/github/git.test.ts` を書く: 一時ディレクトリの bare リポジトリ（既定のブランチ `main`、コミット1つ）を `baseUrl` に `file://` で渡し、`cloneForJob` が浅く取得して作業ブランチ `agent/issue-7-job-3` を作る、作業ディレクトリの `.git/config` と `git remote get-url origin` にトークンの文字列がない、渡したトークンは git の子プロセスの環境変数（`GIT_CONFIG_VALUE_0`）にだけ入る（`execa` の呼び出しを記録して確かめる）、取得の失敗のエラーの文にトークンが入らない（伏せ字）、`AbortSignal` で中断できる（SC-006）
- [ ] T022 [US3] `src/github/git.ts` を作る（T021 を通す。research R8）: `cloneForJob`。リモートの URL は `baseUrl ?? "https://github.com"` と `repo` から作る。`git clone --depth 1 --single-branch --branch <defaultBranch>` → `git -C <dir> switch -c <branch>`。トークンは `GIT_CONFIG_COUNT`・`GIT_CONFIG_KEY_0`・`GIT_CONFIG_VALUE_0` で渡し、`GIT_TERMINAL_PROMPT=0` を付ける
- [ ] T023 [US3] `src/pipeline/worker.test.ts` を書く（偽の GitHub、偽の `install`、偽の 005 の入口、T021 の bare リポジトリ、一時の `work_dir`）: `queued` が2つなら古い順に1つずつ処理し、入口が同時に2回呼ばれない（入口の中で待たせて確かめる。SC-007）、`wake` で待ちを打ち切ってすぐ取り出す、入口が `onPhase` を呼ぶと `implementing` → `testing` → `judging` と移り記録が残る、入口が `pass` を返すと報告（`shipping_not_available`、判定の理由入り）が1回で `failed`、`fail` を返すとその分類で `failed`、取得の失敗は `clone_failed`、インストールの失敗は `install_failed`、入口の例外は `internal_error`、`[limits] job_timeout_minutes` を超えると入口の `signal` が中断され `timeout`（テストでは時間を短くできるよう `WorkerDeps` に時間の上限の上書きを持たせる）、どの終わり方でも `work_dir/job-<id>` が残らず、作業場の片付け（偽物）が呼ばれる（SC-008）、`branch` 列に作業ブランチの名前が入る、`install` と入口に渡る作業ディレクトリの `.git/config` にトークンがない、偽の GitHub が返したトークンの文字列がキャプチャしたログに1度も現れない（SC-006）
- [ ] T024 [US3] `src/pipeline/worker.ts` を作る（T023 を通す。research R7）: `PipelinePort` と入出力の型（data-model.md）、`createWorker`（取り出しのループ、`wake`、1件の処理、時間の上限の `AbortController`、`finally` での片付け）。作業ディレクトリは `join(config.storage.work_dir, \`job-${id}\`, "repo")`。インストールは 003 の `installDependencies` を `pnpm install --frozen-lockfile` で呼ぶ本物の関数を `main.ts` で組み立てる
- [ ] T025 [US3] `src/main.ts` を直す: `requireEnv` で `GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY_PATH`・`GITHUB_WEBHOOK_SECRET` を読み（なければ名前を含むエラーで終了コード 1）、`client.ts` の `GitHubPort` と Worker を組み立てて `createApp` に `webhook` を渡す。005 の入口は、005 がマージされるまでは「`pipeline_failed`: 計画から判定までの工程（005）がまだ組み込まれていません」を返す仮の入口にする。`src/main.test.ts` の既存のテストが通るよう、`startFactory` に GitHub と入口を差し込めるようにする

**Checkpoint**: 偽の入口で、積んだジョブが報告まで1件ずつ流れる

---

## Phase 7: User Story 5 - 再起動しても途中のジョブを宙に浮かせない (Priority: P2)

**Goal**: 起動時に中断されたジョブを片付け、停止の合図で処理中のジョブを中断する

**Independent Test**: 中断された状態のジョブと残骸を用意して起動・停止する

- [ ] T026 [P] [US5] `src/pipeline/worker.test.ts` に足す: `recoverOnStartup` が `planning`〜`judging` のジョブを `failed`（`restarted`）にして各1回報告し、`queued` と `pr_opened` には触らない、`work_dir` の下の `job-*` を消し、作業場の残骸の片付け（003 の `removeStaleSandboxes` の偽物）を呼ぶ。`stop()` で取り出しが止まり、処理中のジョブの入口の `signal` が中断され `failed`（`stopped`）になってから resolve する、処理中のジョブがなければすぐ resolve する
- [ ] T027 [US5] `src/pipeline/worker.ts` に `recoverOnStartup` と `stop()` を足し（T026 を通す）、`src/main.ts` で、HTTP の待ち受けの前に `recoverOnStartup` → Worker の `start()`、停止の合図では Worker の `stop()` → HTTP の停止の順にする。006 の `installSignalHandlers` の停止関数に組み込む

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T028 [P] `deploy/factory.env.example` に `GITHUB_APP_ID=`・`GITHUB_APP_PRIVATE_KEY_PATH=/etc/sakura-factory/github-app.pem`・`GITHUB_WEBHOOK_SECRET=` を足す。`deploy/scripts/setup.sh` の「設定と秘密情報」で、3つが空でないこと、秘密鍵のファイルがあり `root:factory`・`640` であることを確かめ、`factory.toml` の初回の書き換えに `work_dir = "/var/lib/sakura-factory/work"` を足す。`deploy/rehearsal/run.sh` の偽の値に3つと偽の秘密鍵のファイルを足す（起動時に GitHub は呼ばない）
- [ ] T029 [P] `deploy/README.md` に GitHub App の作り方（contracts/github-app.md の権限・イベント・Webhook の URL と秘密）と、秘密鍵の置き方、`500` のときに App の「Recent Deliveries」から再送する手順を足す
- [ ] T030 [P] `docs/design/03` の4章 #1・5章（GitHub 連携・データ・キュー）・8章と `04` の2章 層1を、plan.md の「設計ドキュメントとの差分」どおりに直す
- [ ] T031 `pnpm run check`・`pnpm run secrets:scan`・`pnpm run deploy:lint` を通す。記録したペイロードに実在のアカウント名やメールアドレスがないことを `git grep` で確かめる
- [ ] T032 quickstart.md の2章を手で実行する（署名なしで `401`、偽の App ID で `500`）。結果を journal に書く
- [ ] T033 quickstart.md の3章（テスト用のリポジトリと本物の GitHub App）を1回実行し、結果を journal に書く（M2 の作業。GitHub App の作成は運用者が行う）
- [ ] T034 005 のマージ後に、005 の入口を `PipelinePort` に合わせるつなぎを `src/pipeline/worker.ts`（または 005 の入口の隣）に書き、T025 の仮の入口と差し替える。005 の工程の境目で `onPhase` を呼ぶよう、005 と 007 のどちらを直すかを決めて plan.md に追記する

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3（US1）→ Phase 4（US2）→ Phase 5（US4）→ Phase 6（US3）→ Phase 7（US5）→ Phase 8
- **005 に依存しないのは Phase 1〜6 と Phase 7・8 の T028〜T033**。T034 だけが 005 のマージを待つ
- **006（PR #6）に依存する**: `src/http/app.ts`・`src/main.ts`・`deploy/` を直すので、006 のブランチの上で作るか、006 のマージ後に作る
- T013 と T017 は同じ `webhook.ts`、T012 と T016 は同じ `webhook.test.ts` なので、それぞれ順に行う
- T020 は T017 のコメントの本文を差し替えるので T017 のあと
- T025・T027 は同じ `main.ts` なので順に行う

### Parallel Opportunities

- Phase 2: T004・T005・T008
- US1: T009・T010
- US4: T019 は US2 と並行できる（`report.ts` は受付に依存しない）
- US3: T021 は US2・US4 と並行できる
- Phase 8: T028・T029・T030

## Parallel Example: Phase 2

```text
Task: "T004 src/pipeline/state.test.ts を書く"
Task: "T005 src/queue/jobs.test.ts に足す"
Task: "T008 src/github/port.ts と testing.ts を作る"
```

## Implementation Strategy

### MVP First

1. Phase 1・2 → Phase 3（US1）→ Phase 4（US2）で、Issue の `@agent` が安全にジョブとして積まれる。005 なしで本物の GitHub で確かめられる（T033 の1・3・4）

### Incremental Delivery

1. US1 → US2（受付）
2. US4（報告）→ US3（Worker。仮の 005 の入口で、報告まで流れる）
3. US5（起動と停止）
4. 005 のマージ後に T034 で本物の工程につなぐ
