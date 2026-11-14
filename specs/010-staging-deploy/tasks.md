---

description: "Task list for 010 staging-deploy"
---

# Tasks: ステージングデプロイ（staging-deploy）

**Input**: Design documents from `specs/010-staging-deploy/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。FR-027 と SC-001〜SC-008 が自動テストでの確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。

**Organization**: ユーザーストーリーごとにまとめる。US1〜US3 はどれも P1。US1（受付と成功のデプロイ）が US2（ロールバック）と US3（失敗・中断・取りこぼし）の土台なので US1 → US2 → US3 の順に置く。US4（設定）は P2 だが、設定の項目は Phase 1 で先に足す。US5（デモ用のリポジトリ）はファクトリーのコードに依存しないので、いつでも進められる。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- `octokit` を import してよいのは `src/github/` の中だけ。ほかの層は `GitHubPort` だけを使う（原則 VII）
- テストで GitHub の API と LLM を呼ばない。本物の Docker を使うテストは `*.docker.test.ts` だけ
- docker・compose の子プロセスには、ファクトリーの秘密情報を含む環境を渡さない（`extendEnv: false`。research R4）
- 想定と違う挙動・エラーに当たったら `docs/journal/2026-11-14-010-staging-deploy-実装.md` に記録する

---

## Phase 1: Setup

- [X] T001 `.workshop/devtools/hooks/setup-base` の `apt-get install` に `docker-compose-v2` を足し、`workshop refresh dev` のあと `workshop exec dev -- docker compose version` が通ることを確かめる
- [X] T002 `src/config.test.ts` に contracts/factory-toml.md のテストを足す: `[staging]` を省くと `repo = ""`・`project = "sakura-staging"`・`image_name = "sakura-staging-app"`・`port = 3100`・`health_path = "/healthz"`・`health_timeout_seconds = 60`・`health_interval_seconds = 2`・`health_successes = 3`・`build_timeout_seconds = 600`・`keep_images = 5`・`public_url = ""`。不正（`repo = "a"`・`project = "Bad Name"`・`image_name = "x:tag"`・`port = 80`・`health_path = "healthz"`・`health_timeout_seconds = 0`・`health_successes = 21`・`keep_images = 1`・`public_url = "ftp://x"`・未知の項目）で項目の名前を含むエラー
- [X] T003 `src/config.ts` に `[staging]`（contracts/factory-toml.md の表の型・既定・範囲。`repo` は `^$|^[^/\s]+/[^/\s]+$`、`project` は `^[a-z0-9][a-z0-9_-]*$`、`image_name` は `^[a-z0-9][a-z0-9._/-]*$`、`health_path` は `^/`、`public_url` は `^$|^https?://`、節ごと `default: {}`）を足して T002 を通す。`factory.toml` に `repo = "Coxless/factory-sandbox"` で、`factory.dev.toml`（あれば）に `repo = ""` で、日本語のコメント付きで足す。`specs/001-foundation/contracts/factory-toml.md` の「後続の機能で足した表」に 010 のリンクを足す

---

## Phase 2: Foundational（スキーマ・キュー・GitHub 層・失敗の分類）

- [X] T004 `src/queue/schema.ts` の `deployments` を data-model.md 1章のとおりにする: `DEPLOYMENT_STATUSES = ["queued", "running", "succeeded", "failed"]`、`DEPLOY_STAGES = ["fetch", "build", "release", "health", "interrupted"]`、列 `repo` TEXT NOT NULL・`before_sha`・`failed_stage`・`rollback_healthy`（bool）・`revert_pr_number`・`error`・`started_at` を足す。一意 `deployments_repo_commit_unique(repo, commit_sha)`、索引 `deployments_status_id_idx(status, id)`・`deployments_job_id_idx(job_id)`、CHECK「`(status = 'failed') = (failed_stage IS NOT NULL)`」「`rolled_back = 0` なら `rolled_back_to IS NULL AND rollback_healthy IS NULL`」。`pnpm exec drizzle-kit generate --name staging_deploy` で `drizzle/0005_staging_deploy.sql` を作り（表の作り直しになることを確かめる）、`src/queue/schema.test.ts` に CHECK と一意の制約のテストを足す
- [X] T005 `src/queue/deployments.test.ts` に contracts/module-api.md 4章のテストを先に書く: `enqueueDeployment` は同じ `(repo, commit_sha)` で2回目は `created: false`。`claimNextDeployment` は最も古い `queued` を `running`（`started_at`）にし、なければ undefined、2回呼んでも同じ行を2度返さない。`finishDeployment` は `running` の行だけを変える。`lastSucceededDeployment` は `exceptId` を除いた最新の `succeeded`。`interruptRunningDeployments` は `running` を `failed`（`interrupted`）にして返す。`listDeploymentsForJob` は古い順
- [X] T006 `src/queue/deployments.ts` に T005 の関数を実装する（即時トランザクション、条件付きの UPDATE … RETURNING。`error` は 2000 文字で切り詰める）
- [X] T007 [P] `src/github/port.ts` に `findMergedPullRequest`・`getDefaultBranchHead` と `PushEvent`（data-model.md 6章）を足す。`src/github/testing.ts` の偽の GitHub に同じ操作を足す: `FakePullRequest.mergeCommitSha`、`mergePullRequest(number, mergeCommitSha?)`、`options.defaultBranchHead`（`{ branch, sha }`）
- [X] T008 [P] `src/github/client.ts` に本物の `findMergedPullRequest`（`GET /repos/{o}/{r}/commits/{sha}/pulls` から `merged_at` があり `merge_commit_sha === sha` の PR の番号）と `getDefaultBranchHead`（`GET /repos/{o}/{r}` の `default_branch` → `GET /repos/{o}/{r}/branches/{branch}` の `commit.sha`）を足す
- [X] T009 `src/pipeline/report.ts` の `FAILURE_KINDS` に `deploy_failed`（「ステージングへのデプロイ（取得・ビルド）に失敗しました。ステージングは前の版のままです」）を足す。`failJob` は、失敗する前の状態が `merged`・`deploying` のジョブでは PR を Draft に変えない（`handOverPullRequest` を呼ばない）。`src/pipeline/report.test.ts` にテストを足す
- [X] T010 `src/pipeline/ci.ts` の「PR がマージ済み」の処理を `markMerged(deps, job): Promise<boolean>` として切り出して export し（`ci_waiting` → `merged`、`merged` の記録、`refreshCiSection`）、`checkCiJob` から呼ぶ。009 の既存のテストが通ることを確かめる

**Checkpoint**: スキーマ・キュー・GitHub 層が揃う。001〜009 の既存のテストが通ること

---

## Phase 3: User Story 1 - main への反映をステージングに自動で出す (Priority: P1) 🎯 MVP

**Goal**: push を受けて積み、実行器がビルド → 入れ替え → ヘルスチェックをして、ジョブを `deployed` にし PR の本文に書き足す

**Independent Test**: 偽の `StagingRuntime`・偽の GitHub・bare リポジトリで、署名付きの push を受付に送り、実行器の結果・記録・状態・PR の本文を確かめる

### Tests for User Story 1

- [X] T011 [P] [US1] `src/github/events.test.ts` に `toPushEvent` のテストを書く: main への push → `{ repo, ref, defaultBranch, before, after, deleted }`、`deleted` を省くと偽、項目の欠け → `PayloadError`、ほかのイベント → ignored。フィクスチャを `src/github/fixtures/push.main.json` に置く
- [X] T012 [P] [US1] `src/http/webhook.test.ts` に contracts/webhook.md の push のテストを書く: `[staging].repo` が空 → ignored、別のリポジトリ・タグ・別のブランチ・削除 → ignored、main → `202 deploy_queued`（`deployments` に `queued`、`image_tag` は `sakura-staging-app:<先頭12文字>`）と `wakeDeployer` が呼ばれる、同じ commit の2回目 → `duplicate`、リポジトリ名の大文字小文字の違いは同じとみなす、DB に書けない → 500。GitHub の API を呼ばないこと
- [X] T013 [P] [US1] `src/deploy/health.test.ts` に `waitHealthy` のテストを書く（偽の `fetch`・`sleep`・時計）: 200 が3回続けば通過、接続の拒否のあとに通過、200 → 500 → 200 → 200 → 200 で通過（数え直し）、上限まで通らなければ `healthy: false` と最後の状態、`signal` で打ち切り
- [X] T014 [P] [US1] `src/github/git.test.ts` に `fetchCommit` のテストを書く（bare リポジトリ）: 指定した commit のファイルが取り出され `.git` がない、ない commit → `CloneError`、トークンが引数・エラー文に出ない
- [X] T015 [P] [US1] `src/pipeline/report.test.ts` にデプロイの欄（contracts/report.md 1章）のテストを書く: 各状態の行、`public_url` の有無、`replaceDeploySection` が CI の欄の後ろに入れる・既存の欄を置き換える・欄がなければ末尾に足す
- [X] T016 [US1] `src/deploy/runner.test.ts` に成功の場合のテストを書く（`src/deploy/testing.ts` の偽の `StagingRuntime`、偽の GitHub、bare リポジトリ、偽の `health`）: `merged` のジョブ → `deploying` → `deployed`、`deploy_started`・`deploy_result` の記録、PR の本文のデプロイの欄。ジョブが `ci_waiting`（PR はマージ済み）→ `merged` を経て `deployed`。人間の push（PR なし）→ `job_id` NULL で `succeeded`。PR のジョブが `failed` → 状態を変えず `job_id` だけ入る。`findMergedPullRequest` の失敗 → ジョブなしで続け `error` に残る。2件積むと順に処理される。成功のあと `keep_images` より古いイメージを消し、今と戻し先は消さない。`build` と `up` に渡すイメージの名前と、ビルドのディレクトリが終わったあとに消えていること

### Implementation for User Story 1

- [X] T017 [US1] `src/github/events.ts` に `toPushEvent`（contracts/webhook.md の項目を TypeBox で検証）を実装して T011 を通す
- [X] T018 [US1] `src/http/webhook.ts` に push の受付（contracts/webhook.md の判定の順、`enqueueDeployment`、応答のあとに `wakeDeployer`）を実装して T012 を通す。`WebhookDeps` に `wakeDeployer?: () => void` を足す
- [X] T019 [P] [US1] `src/deploy/health.ts` に `waitHealthy`（research R6。1回の要求の上限 5 秒）を実装して T013 を通す
- [X] T020 [P] [US1] `src/github/git.ts` に `fetchCommit`（research R4: `git init` → `fetch --depth 1 <url> <sha>`（トークンは環境変数）→ `checkout --detach FETCH_HEAD` → `.git` を消す）を実装して T014 を通す。bare リポジトリで SHA を指定した取得が通ることを確かめ、通らなければ journal に書いて対処する
- [X] T021 [US1] `src/pipeline/report.ts` に `renderDeploySection`・`replaceDeploySection`・`refreshDeploySection(deps, job)`（`listDeploymentsForJob` から作り直し、伏せ字にして書く。失敗は `deploy_body_failed`）を実装して T015 を通す
- [X] T022 [P] [US1] `src/deploy/testing.ts` に偽の `StagingRuntime`（呼び出しの記録、ビルド・入れ替え・止める・イメージの有無の結果を決められる）を作る
- [X] T023 [US1] `src/deploy/runner.ts` に `runDeployment`（contracts/module-api.md 7章の 1〜5・7）と `createDeployer`（`start`・`wake`・`stop`。research R2）を実装して T016 を通す。作業ディレクトリは `[storage].work_dir/deploy-<id>`
- [X] T024 [US1] `deploy/staging/compose.yaml` を contracts/staging.md 1章のとおりに作り、`src/deploy/staging.ts` に `createDockerStaging`（`docker build --label sakura-factory.staging=1 -t`・`docker compose -p -f up -d --remove-orphans --force-recreate`・`down --remove-orphans`・`docker image inspect`・`docker image rm`。子プロセスの環境は `PATH`・`HOME`・`DOCKER_*`・`STAGING_IMAGE`・`STAGING_PORT` だけ、`build_timeout_seconds` の上限、失敗は stderr の末尾を伏せ字にした `DeployStepError`）・`STAGING_COMPOSE_FILE`・`imageTagFor` を実装する。`deploy/scripts/lint.sh` に `docker compose -f deploy/staging/compose.yaml config -q`（`STAGING_IMAGE`・`STAGING_PORT` に仮の値）を足す
- [X] T025 [US1] `src/main.ts` に実行器をつなぐ: `FactoryServices.staging`、`createServices` で `createDockerStaging`、`createDeployer` の開始と停止（Worker → 見回り → 実行器 → HTTP の順）、受付に `wakeDeployer`。`src/main.test.ts` に、偽の `staging` で push を受けて `deployed` まで進むテストを足す

**Checkpoint**: push からステージングへのデプロイが、偽物で一通り動く

---

## Phase 4: User Story 2 - ヘルスチェックに失敗したら直前の版に戻し、revert PR を作る (Priority: P1)

**Goal**: 入れ替え・ヘルスチェックの失敗で直前に成功したイメージに戻し、revert PR を作り、ジョブを `rolled_back` にして報告する

**Independent Test**: 偽の `StagingRuntime` でヘルスチェックを失敗させ、戻し先・revert PR（bare リポジトリへの push と偽の GitHub の PR）・記録・状態・報告を確かめる

### Tests for User Story 2

- [X] T026 [P] [US2] `src/github/git.test.ts` に `revertRange` のテストを書く（bare リポジトリ）: 範囲の変更を打ち消す1つの commit が新しいブランチに push され、既定のブランチは変わらない。`before` が NULL・0 だけ → `no_range`、祖先でない → `not_ancestor`、既定のブランチの履歴にない → `not_in_branch`、後の commit と衝突 → `conflict`（作業ディレクトリが元に戻る）、打ち消すと変更が空 → `empty`。作成者は渡したボット、フックが動かない
- [X] T027 [P] [US2] `src/pipeline/report.test.ts` に contracts/report.md 2章（ロールバックの報告）・3章（revert PR の題と本文）のテストを書く: 戻し先あり・なし、戻した版のヘルスチェックの通過・失敗、revert PR あり・作らなかった理由
- [X] T028 [US2] `src/deploy/runner.test.ts` にロールバックのテストを書く: 直前の `succeeded` があり、ヘルスチェックが失敗 → 直前のイメージで `up`、もう一度ヘルスチェック、`failed(health)`・`rolled_back = 1`・`rolled_back_to`・`rollback_healthy = 1`、revert PR（`draft: false`、`enableAutoMerge` を呼ばない、ブランチ `factory/revert-<7文字>`）、`revert_pr_number`、ジョブ `rolled_back`、PR の本文、Issue に1回報告（2回処理しても1回）。`up` の失敗 → `failed(release)` で同じ。直前の成功がない・イメージが消えた → `down`・`rolled_back_to` NULL。戻した版も不健康 → `rollback_healthy = 0` と `error` のログ。revert を作れない → `revert_skipped` と報告に理由。revert PR の作成に失敗 → 記録に残し、ロールバックはそのまま

### Implementation for User Story 2

- [X] T029 [US2] `src/github/git.ts` に `revertRange`（research R8: 既定のブランチを履歴ごと取得、`merge-base --is-ancestor`、`revert --no-commit before..after`、衝突なら `revert --abort`、`commitForJob` で commit、`pushBranch`）を実装して T026 を通す
- [X] T030 [US2] `src/pipeline/report.ts` に `renderRollbackReport`・`renderRevertPullRequest`（題と本文）・`postRollbackReport(deps, job, …)`（`report_posted` の記録で二重にしない。失敗は `report_failed`）を実装して T027 を通す
- [X] T031 [US2] `src/deploy/runner.ts` に contracts/module-api.md 7章の 6（ロールバック → revert PR → 記録 → ジョブ `rolled_back` → PR の本文 → 報告）を実装して T028 を通す
- [X] T032 [US2] `src/deploy/staging.docker.test.ts` を書く（quickstart.md 1章）: Docker・作業場のイメージ・`docker compose` がなければ理由を出して飛ばす（`FACTORY_SANDBOX_REQUIRED=1` なら失敗）。一時ディレクトリに `FROM factory-sandbox:latest` で `/healthz` が環境変数（`HEALTH_STATUS`、Dockerfile の `ENV`）の状態を返す Node のアプリを2つ（200 と 500）作り、プロジェクト `sakura-staging-test`・ポート 3199 の設定で、本物の `createDockerStaging` と `waitHealthy` を使って: 1つ目を `build`・`up` → 通過、2つ目 → 通らない → 1つ目に `up` → 通過。終わったら `down` とイメージの削除を必ず行う

**Checkpoint**: レベルBの安全弁（ロールバックと revert PR）が動く

---

## Phase 5: User Story 3 - ビルドの失敗・中断・取りこぼしでも状態を残さない (Priority: P1)

**Goal**: 取得・ビルドの失敗、再起動・停止、停止中の push の取りこぼしで、記録とジョブが途中のまま残らない

**Independent Test**: 偽の `StagingRuntime` でビルドを失敗させる。途中のデプロイの記録を作ってから起動する。偽の GitHub の既定のブランチの先頭を変えて起動する

### Tests for User Story 3

- [X] T033 [US3] `src/deploy/runner.test.ts` にテストを足す: ビルドの失敗 → `failed(build)`、`up` を呼ばない、ジョブ `failed`（`deploy_failed`）・Issue に1回報告・PR を Draft に変えない、revert PR を作らない。取得の失敗 → `failed(fetch)`。`recoverDeployments`: `running` → `failed(interrupted)`、`deploying` のジョブ → `failed`（`restarted`）、`queued` は残る、`deploy-*` のディレクトリが消える。`catchUpDeployments`: 先頭が記録にない → `queued`（`before_sha` は最後の記録の commit）、記録にある → `up_to_date`、`repo` が空 → `disabled`（GitHub を呼ばない）、GitHub の失敗 → `error`（例外を投げない）。`stop()` の途中 → 実行中の `build` の `signal` が打ち切られ、`failed(interrupted)`、ジョブ `failed`（`stopped`）

### Implementation for User Story 3

- [X] T034 [US3] `src/deploy/runner.ts` に取得・ビルドの失敗の扱い（`failJob(deploy_failed)`、`detail` に段階とエラーの末尾）・中断の扱い・`recoverDeployments`・`catchUpDeployments` を実装して T033 を通す
- [X] T035 [US3] `src/main.ts` の起動に `recoverDeployments`（`recoverOnStartup` のあと）と `catchUpDeployments`（待ち受けのあと、待たない）を足し、`src/main.test.ts` に起動時の掃除のテストを足す

**Checkpoint**: 再起動・停止・ビルドの失敗のあとに、`running`・`deploying` が残らない

---

## Phase 6: User Story 4 - ステージングの動かし方を設定で変える (Priority: P2)

**Goal**: `[staging]` の値で、ヘルスチェック・イメージの片付け・ステージングの URL が変わる

**Independent Test**: 設定の値を変えて実行器の振る舞いが変わることを確かめる（設定の検証は T002 で確かめ済み）

- [X] T036 [US4] `src/deploy/runner.test.ts` にテストを足して通す: `health_timeout_seconds`・`health_interval_seconds`・`health_successes`・`port`・`health_path` が `waitHealthy` に渡る（URL は `http://127.0.0.1:<port><health_path>`）、`keep_images = 3` で直近 3 個より古いものを消す、`public_url` が PR の本文に出る・空なら出ない

---

## Phase 7: User Story 5 - デモ用の対象リポジトリを用意する (Priority: P2)

**Goal**: `Coxless/factory-sandbox` を、ファクトリーが依頼からステージングまで出せる形にする

**Independent Test**: clone して作業場のイメージで `pnpm run check`、Dockerfile のイメージの `/healthz` が 200。GitHub のブランチ保護と auto-merge の設定を `gh api` で確かめる

- [X] T037 [US5] `Coxless/factory-sandbox` の今の中身を確かめ、`src/server.js`（`node:http`、`PORT`（既定 3000）で待ち受け、`GET /healthz` → `200 {"status":"ok"}`、`GET /` → 短い HTML、ほか → 404）と `src/server.test.js`（`node --test`。ポート 0 で起動して `/healthz` を確かめる）、`Dockerfile`（`node:24-slim`、`COPY src`・`package.json`、`USER node`、`EXPOSE 3000`、`CMD ["node", "src/server.js"]`）、`.dockerignore`、`.github/workflows/ci.yml`（ジョブ名 `check`、Node 24、`corepack enable`、`pnpm install --frozen-lockfile`、`pnpm run check`）を足し、AGENTS.md にステージングの約束（contracts/staging.md 2章）を書く。ブランチで push して PR を作り、CI が通ってからマージする
- [X] T038 [US5] `gh api` で `Coxless/factory-sandbox` の設定を変える: `allow_auto_merge: true`・`allow_squash_merge: true`・`delete_branch_on_merge: true`、main のブランチ保護（必須チェック `check`、`strict: false`、管理者にも適用しない、必須レビューなし）。設定の結果を journal に書く
- [X] T039 [US5] quickstart.md 2章を Workshop で流し、デモ用のリポジトリのイメージが compose で起動して `/healthz` が 200 を返すことを確かめる。作業場のイメージで `pnpm install --frozen-lockfile && pnpm run check` が `--network none` でも通ることを確かめる

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T040 [P] `docs/design/03_アーキテクチャと技術スタック.md` を plan.md の「設計ドキュメントとの差分」のとおりに直す（3章・4章 #10 #11・5章 ステージングとデータ・キュー・8章）。`docs/design/04_ガードレールとハーネス設計.md` の層9を直す
- [X] T041 [P] `deploy/README.md` にステージングの節を書く（`[staging]` の設定、`docker compose -p sakura-staging ps` での確かめ方、`deployments` の見方、App の `push` の購読）。`502` の注記を「デプロイが一度もないあいだは `502`」に直す
- [X] T042 [P] `docs/journal/2026-11-14-010-staging-deploy-specとplan.md` に spec・plan で比べて決めたこと（push をまとめずに1件ずつ、ジョブとの結び付けの方法、revert PR を自動マージしない、ビルドの失敗で revert PR を作らない）を書く
- [X] T043 `pnpm run check`・`pnpm run secrets:scan`・`pnpm run deploy:lint` を Workshop で通す。本物の Docker のテストが飛ばされずに通ったことを確かめる
- [X] T044 spec.md の Success Criteria と FR を見直し、テストで確かめていない項目があれば足す。`docs/journal/2026-11-14-010-staging-deploy-実装.md` に実装で分かったこと（数値・エラー文）をまとめる

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3（US1）→ Phase 4（US2）・Phase 5（US3）→ Phase 6（US4）→ Phase 8
- Phase 7（US5）はファクトリーのコードに依存しない。いつでも進められる（T037 → T038 → T039）
- US2・US3 は US1 の `runner.ts` に足すので、US1 のあと。US2 と US3 は同じファイル（`runner.ts`・`runner.test.ts`）を触るので順に行う
- 各ストーリーの中: テスト → 実装

## Parallel Example: User Story 1

```text
T011 events.test.ts / T012 webhook.test.ts / T013 health.test.ts / T014 git.test.ts / T015 report.test.ts
→ T017 events.ts / T019 health.ts / T020 git.ts / T022 deploy/testing.ts（並行）
→ T018 webhook.ts / T021 report.ts → T023 runner.ts → T024 staging.ts → T025 main.ts
```

## Implementation Strategy

- **MVP**: Phase 1〜3（US1）。push からステージングへの成功のデプロイが偽物で動き、ジョブが `deployed` になる
- 次に US2（ロールバック。原則 VI の MUST）と US3（失敗・中断）を足して、レベルBとして完成させる
- US5（デモ用のリポジトリ）は M4 の24時間稼働の土台なので、010 の中で終わらせる
