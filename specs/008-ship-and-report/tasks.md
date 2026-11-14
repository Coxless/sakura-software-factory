---

description: "Task list for 008 ship-and-report"
---

# Tasks: 出荷とレポート（ship-and-report）

**Input**: Design documents from `specs/008-ship-and-report/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。FR-029 と SC-001〜SC-007 が自動テストでの確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。

**Organization**: ユーザーストーリーごとにまとめる。US1〜US3 はどれも P1 だが、US1（PR にする）が US2 の出荷前チェックの結果で通常の PR か Draft かを決めるので、US2 → US1 → US3 の順に置く。US4（設定）は P2。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US4）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- `octokit` を import してよいのは `src/github/` の中だけ。ほかの層は `GitHubPort` だけを使う（原則 VII）
- テストで GitHub の API と LLM を呼ばない。gitleaks は本物（Workshop・CI に入っている）を使い、見つからなければテストを飛ばさずに失敗させる
- テストで使う本物の形の偽のトークンは、テストの中で乱数から組み立てる（ソースに固定の値を書かない。`pnpm run secrets:scan` に当たらないように）
- 想定と違う挙動・エラーに当たったら `docs/journal/<実装した日>-008-ship-and-report-実装.md` に記録する

---

## Phase 1: Setup

- [X] T001 `src/config.test.ts` に `[auto_merge]` の追加のテストを足す（contracts/factory-toml.md の表）: 省略時に `skip_label = "no-auto-merge"`、`forbidden_paths` の既定に `.gitleaks.toml`・`.gitleaksignore` が入る。`skip_label` が空・51 文字以上でエラー（「空でない、50 文字以下」）
- [X] T002 `src/config.ts` に `skip_label` と既定の禁止パスを足し（T001 を通す）、`factory.toml`・`factory.dev.toml` の `[auto_merge]` に日本語のコメント付きで足す。`specs/001-foundation/contracts/factory-toml.md` の「後続の機能で足した表」に 008 のリンクを足す

---

## Phase 2: Foundational（GitHub 層・git・失敗の分類）

- [X] T003 [P] `src/github/port.ts` に contracts/module-api.md の追加（`getIssue` の `labels`、`getBotIdentity`、`createPullRequest`、`enableAutoMerge`、`convertToDraft`、`DraftUnavailableError`）を足し、`src/github/testing.ts` の偽の GitHub に同じ操作を足す（作った PR の一覧・auto-merge と Draft の状態・Issue のラベル・失敗させる操作 `failOn` を持ち、呼び出しを記録する）。007 の既存のテストが通ることを確かめる
- [X] T004 [P] `src/github/client.ts` に本物を足す（research R6・R7）: `getIssue` に `labels`（名前の配列）、`getBotIdentity`（App の JWT で `GET /app` → `GET /users/{slug}[bot]`、プロセスの中で覚える）、`createPullRequest`（REST。`draft: true` で `422` かつ Draft が使えない旨のメッセージなら `DraftUnavailableError`）、`enableAutoMerge`（GraphQL `enablePullRequestAutoMerge`、`mergeMethod: SQUASH`）、`convertToDraft`（GraphQL `convertPullRequestToDraft`）。GitHub を呼ぶので単体テストは書かない（007 と同じ）
- [X] T005 [P] `src/github/git.test.ts` に commit・push のテストを足す（ローカルの bare リポジトリを `file://` で clone した作業ディレクトリで）: `commitForJob` が追跡していない新しいファイルを含み `.gitignore` に従う1つの commit を作り、作成者とコミッターが渡したボットの名前になり、`{ base, head }` を返す。作業ディレクトリの `.git/hooks/pre-commit`（失敗するスクリプト）が実行されない。`changedFiles` が名前の変更で変更前と変更後の両方のパスを返し、行数がバイナリを 0 として数える。`pushBranch` が作業ブランチだけを push し、既にリモートに別の履歴の同名ブランチがあると `ShipGitError` で上書きしない。偽の `GitRunner` で、トークンが引数に現れず環境変数（`GIT_CONFIG_*`）だけで渡り、`GIT_CONFIG_GLOBAL=/dev/null`・`GIT_CONFIG_NOSYSTEM=1`・`core.hooksPath=/dev/null` が付くこと、エラーの文のトークンが伏せられること
- [X] T006 `src/github/git.ts` に `commitForJob`・`changedFiles`・`pushBranch`・`ShipGitError` を作る（T005 を通す。contracts/module-api.md、research R2・R5）。007 の `cloneForJob` のトークンの渡し方とマスクを共通の関数にまとめる（振る舞いは変えない）
- [X] T007 [P] `src/pipeline/report.test.ts` に失敗の分類の変更のテストを足す: `secret_detected`・`unshippable_change`・`ship_failed` の説明の文（contracts/report.md）、`shipping_not_available` がない、作業ブランチの行が `pushed: true` で「push 済み」になる、`secret_detected` の詳細が `- <file>:<line>（<rule>）` の形で 20 件までになり値を含まない
- [X] T008 `src/pipeline/report.ts` の `FAILURE_KINDS`・`describeKind`・`renderFailureReport`・`FailJobExtra`（`pushed`・`conditions`）を変える（T007 を通す）。`src/pipeline/worker.ts` の `classifyOutcome` から `passed` の分岐を一時的に `internal_error`（出荷の工程が未接続）にして型を通す（US1 で置き換える）

**Checkpoint**: `pnpm run check` が通る。007 の振る舞いは `passed` のジョブ以外で変わらない

---

## Phase 3: User Story 2 - 出荷前チェックで自動マージか Draft かを決める (Priority: P1)

**Goal**: commit を対象に6条件をすべて評価し、push してよいか（秘密情報・CI の定義）を決める

**Independent Test**: 6条件を1つずつ外した入力で `evaluateShipChecks` の結果を確かめ、本物の gitleaks で秘密情報の見落としがないことを確かめる

- [X] T009 [P] [US2] `src/pipeline/ship-checks.test.ts` に `evaluateShipChecks` のテストを書く（純粋関数。data-model.md の表）: すべて満たす → `unmet` が空・`blocker: null`。1つずつ外す（diff が `max_diff_lines` を1行超える、禁止パスに当たる、`secrets.status` が `found`・`unavailable`、`skip_label` あり（大文字と小文字を区別しない）・ラベルの取得の失敗、作業の種類が許可にない・計画がない）→ その条件だけが `unmet`。複数を外す → すべてが `unmet` に6条件の順で入る（最初で止めない）。`.github/workflows/ci.yml`（名前の変更の変更前のパスを含む）→ `blocker: "unshippable_change"`。`forbidden_paths` から `.github/workflows/**` を外した設定でも `unshippable_change`。`secrets` が `found` と workflows の両方 → `secret_detected` を優先
- [X] T010 [P] [US2] `src/pipeline/ship-checks.test.ts` に `scanSecrets`・`findInlineAllows` のテストを書く（一時ディレクトリの git リポジトリで、本物の gitleaks。research R4 の表をすべて再現する）: 秘密情報なし → `clean`。本物の形の GitHub トークンを足す commit → `found`（`file`・`line`・`rule` が入り、どの値にもトークンが含まれない）。同じ commit で `.gitleaks.toml` に許可を足しても `found`。基準のコミットの `.gitleaks.toml` が許可する偽の値 → `clean`。基準の `.gitleaksignore` → 従う。作業ツリーで足した `.gitleaksignore` → 効かない。`gitleaks:allow` の行 → `findInlineAllows` が見つける。`base` に存在しないコミットを渡す（走査 0）→ `unavailable`。`gitleaksPath` に存在しないパス → `unavailable`。時間の上限を過ぎる（`timeoutMs: 1`）→ `unavailable`
- [X] T011 [US2] `src/pipeline/ship-checks.ts` を作る（T009・T010 を通す。contracts/module-api.md、research R3・R4）: `evaluateShipChecks`（禁止パスは `posix.matchesGlob`。003 の `src/sandbox/paths.ts` と同じ判定）、`scanSecrets`（基準のコミットの `.gitleaks.toml`・`.gitleaksignore` を一時ディレクトリに書き出して `--config`・`--gitleaks-ignore-path` に渡す。基準になければ `[extend] useDefault = true` だけ。`--no-banner --no-color --redact --exit-code 3 --report-format json`。終了コード 3 → `found`、0 かつ標準エラーに `1 commits scanned` があり `ERR`・`FTL` の行がない → `clean`、それ以外 → `unavailable`。一時ディレクトリは必ず消す）、`findInlineAllows`（diff の追加行の `gitleaks:allow`、規則名 `gitleaks-allow-comment`）

**Checkpoint**: 秘密情報を含む commit が `clean` になる経路がない（SC-002 の前提）

---

## Phase 4: User Story 1 - 判定に合格した変更を PR にする (Priority: P1) 🎯 MVP

**Goal**: commit → 出荷前チェック → push → PR → auto-merge か Draft → `ci_waiting`

**Independent Test**: ローカルの bare リポジトリと偽の GitHub で、合格のジョブが PR になり `ci_waiting` で止まることを確かめる

- [X] T012 [P] [US1] `src/pipeline/ship.test.ts` を書く（ローカルの bare リポジトリ、偽の GitHub、本物の gitleaks、`judging` のジョブ）:
  - 6条件を満たす → bare リポジトリに作業ブランチが1 commit で push され、偽の GitHub に通常の PR（`base` は既定のブランチ、本文に `Refs #<issue>` があり `Closes`・`Fixes`・`Resolves` がない）と auto-merge の有効化が記録され、`decision: "auto_merge"`。状態が `judging` → `pr_opened` → `ci_waiting`（`job_events` に2件）、`jobs.pr_number` が入る。`job_events` に `ship_checks` と `shipped` の `note`
  - 1条件を外す（作業の種類が `feature`）→ Draft の PR、auto-merge は呼ばれない、`decision: "draft"`、`unmet: ["work_type"]`
  - `enableAutoMerge` を失敗させる → `convertToDraft` が呼ばれ `decision: "draft"`、`notes` に `auto_merge_failed: <理由>`。両方を失敗させる → `decision: "unsettled"`、状態は `ci_waiting`
  - `createPullRequest` が `DraftUnavailableError` → 通常の PR で作り直し、auto-merge は呼ばれない、`notes` に `draft_unavailable`
  - 秘密情報を足す変更 → bare リポジトリに作業ブランチがない、PR がない、`failed`（`secret_detected`）、Issue に失敗の報告が1回でトークンの値を含まない。`.github/workflows/x.yml` を足す変更 → 同じく push なし、`unshippable_change`
  - push を失敗させる（bare リポジトリに同名で別の履歴のブランチを先に作る）→ `ship_failed`、PR なし。`createPullRequest` を失敗させる → `ship_failed`、報告の作業ブランチの行が「push 済み」
  - `interruption` が push の前に `stopped`・`timeout` を返す → push なし、`failed`（同名）。push のあとに返すようにしても PR まで作って `ci_waiting`
  - Issue のラベルは PR を作る直前に取り直す（偽の GitHub のラベルを commit のあとに変えて反映される）
  - Issue へのコメント（出荷の知らせ）が1回、`ship_report_posted` の `note`。投稿を失敗させる → `ci_waiting` のまま、`ship_report_failed` の `error`
  - LLM の呼び出しが増えない（`llm_calls` の件数が変わらない）
  - 作業ディレクトリに変更がない（diff が空）→ commit・push・PR をせず `failed`（`internal_error`）
  - 記録用の logger の出力（テストで集めた JSON）に、push に使ったトークンの値が現れない
- [X] T013 [US1] `src/pipeline/ship.ts` に `shipJob` を作る（T012 を通す。contracts/module-api.md、research R1〜R9）: 変更がなければ `internal_error` で `failJob` → ボットの名前 → `commitForJob`（メッセージは PR の題・計画の概要・`Refs #<issue>`・`Factory-Job: <id>`）→ `changedFiles` → `scanSecrets`＋`findInlineAllows`（`git diff <base> <head>` の追加行）→ Issue を取り直してラベル → `evaluateShipChecks` → `ship_checks` を記録 → `blocker` があれば `failJob`（`conditions` 付き）→ `interruption()` を確かめる → `getCloneAccess` でトークンを取り直して `secrets` に足す → `pushBranch` → `createPullRequest`（本文は US3 の `renderShipReport`。US3 の前は仮の本文でよい）→ auto-merge か Draft（R6 の失敗の扱い）→ 1つのトランザクションで `judging` → `pr_opened` → `ci_waiting` と `pr_number` → `shipped` を記録 → Issue に知らせる。例外を投げない（想定外は `internal_error` で `failJob`）
- [X] T014 [US1] `src/pipeline/worker.test.ts` に足す: 偽の 005 の入口が `passed` を返すと出荷に進み（ローカルの bare リポジトリ、偽の GitHub）、ジョブが `ci_waiting` で終わり、作業ディレクトリが片付けられ、次のジョブを取り出す。`ci_waiting` のジョブは `recoverOnStartup` で `failed` にならない（FR-019、SC-007）。007 の `shipping_not_available` のテストを置き換える
- [X] T015 [US1] `src/pipeline/worker.ts` を変える（T014 を通す）: `classifyOutcome` から `passed` を消し、`result.outcome === "passed"` なら `shipJob` を呼ぶ（`interruption` と `secrets` を渡す）。`WorkerDeps` に `gitleaksPath?` を足す。作業ディレクトリの片付けは出荷のあと。`src/main.ts` の組み立てに出荷の依存を渡す

**Checkpoint**: 合格のジョブが PR になり `ci_waiting` で止まる（US1 の Acceptance 1〜6）

---

## Phase 5: User Story 3 - まとめレポートで、自動マージした・しなかった理由を伝える (Priority: P1)

**Goal**: PR の本文に6条件の表と振り分けの理由、Issue に PR へのリンク

**Independent Test**: 条件の組み合わせを変えて、PR の本文と Issue のコメントの文面を確かめる

- [ ] T016 [P] [US3] `src/pipeline/report.test.ts` に `renderShipReport`・`renderShipNotice` のテストを足す（contracts/report.md）: 6条件の表（✅／❌ と値）、振り分けの文（`auto_merge`・`draft`・`unsettled`、`draft_unavailable`・`auto_merge_failed` の追記）、`Refs #<issue>` があり閉じるキーワードがない、計画・受け入れ条件・工程内テスト・判定・やり直し・消費したリクエスト・変更の行、ファイルの一覧が 50 件で「ほか <n> 件」、判定の理由が 2000 文字で切り詰め、本文全体が 60000 文字以下、秘密情報らしい文字列が伏せ字（`maskWith` を通した結果で確かめる）、PR の題が計画の概要の1行目を 72 文字で切り詰めたもの・計画がなければ `Issue #<番号> への対応`
- [ ] T017 [US3] `src/pipeline/report.ts` に `renderShipReport`・`renderShipNotice`・`pullRequestTitle` を作り（T016 を通す）、`src/pipeline/ship.ts` の PR の本文と Issue のコメントをこれに替える。T012 のテストに PR の本文・Issue のコメントの文面の確認を足す

**Checkpoint**: 出荷した PR の本文に6条件と振り分けの理由がある（SC-003）

---

## Phase 6: User Story 4 - 自動マージの条件を設定で変える (Priority: P2)

**Goal**: 設定で振り分けが変わり、不正な設定では起動しない

**Independent Test**: 設定を変えて同じ変更の振り分けが変わることを確かめる

- [ ] T018 [US4] `src/pipeline/ship.test.ts` に設定の効き目のテストを足す: `max_diff_lines = 10` で 20 行の変更が Draft、`allowed_work_types` に `feature` を足すと `feature` で auto-merge、`skip_label` を別の名前にするとそのラベルで Draft。`src/config.test.ts` で、知らない作業の種類・`max_diff_lines = 0`・空の `skip_label` が項目の名前を含むエラーになることを確かめる（001 の既存のテストで足りていればそれを確かめるだけ）

---

## Phase 7: Polish & Cross-Cutting

- [ ] T019 [P] `src/ship-dev.test.ts` を書き、`src/ship-dev.ts` と `package.json` の `ship:dev` を作る（contracts/ship-dev.md）: 引数の検証（`--repo` の形、`--issue` が正の整数、`--patch` のファイルがある、`--work-type` が `WORK_TYPES`、`--db` の既定は一時ディレクトリ）と終了コード（0・1・2）。テストでは GitHub 層と clone を差し替えてローカルの bare リポジトリで `shipJob` まで通す。LLM の設定（APIキー）を要求しない
- [ ] T020 [P] 設計ドキュメントと constitution を直す（plan.md の「設計ドキュメントとの差分」）: `docs/design/03_アーキテクチャと技術スタック.md` の 3章・4章 #7・#11・8章、`docs/design/04_ガードレールとハーネス設計.md` の 2章 層6・実装メモ。`.specify/memory/constitution.md` の原則 VI に「秘密情報が見つかった（確かめられない）変更と、App の権限で push できない変更（`.github/workflows`）は、Draft にもせず push しないで失敗として報告する」を足し、v1.3.2（PATCH、文言の明確化）に上げて Sync Impact Report を更新する（analyze D1）
- [ ] T021 [P] `specs/007-github-intake/` の `shipping_not_available` の記述（data-model.md・contracts/report.md・research.md R2）に「008 で出荷の工程に置き換えた」と書き足す（007 の決定を消さず、008 へのリンクを足す）
- [ ] T022 `pnpm run check`・`pnpm run secrets:scan`・`pnpm run deploy:lint` を通す。`factory.toml` の変更で `pnpm run deploy:rehearsal` の設定の検証（9b・9c など）が壊れていないことを確かめる
- [ ] T023 quickstart.md の2章（`ship:dev` で本物の GitHub）を実行し、結果と、判定の合格から PR ができるまでの所要時間（SC-005、1 分以内）を journal に書く（`factory-sandbox` の CI・ブランチ保護・auto-merge の許可は運用者の作業。用意できていなければ、できた項目だけを行い、残りを journal に書く）

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US2（Phase 3）→ US1（Phase 4）→ US3（Phase 5）→ US4（Phase 6）→ Polish
- Phase 2 の中: T003・T004・T005・T007 は並行できる。T006 は T005 のあと、T008 は T007 のあと
- US1 の `shipJob`（T013）は US2 の `evaluateShipChecks`・`scanSecrets`（T011）と Phase 2 の git・GitHub 層に依存する
- US3 は US1 の `shipJob` の本文を差し替えるだけなので、US1 のあと
- T023 は T019 と運用者の準備（テスト用のリポジトリの CI・ブランチ保護）に依存する

## Parallel Example

```text
# Phase 2 の最初に並行して:
T003 src/github/port.ts・testing.ts
T004 src/github/client.ts
T005 src/github/git.test.ts
T007 src/pipeline/report.test.ts

# US2 のテストを並行して:
T009 evaluateShipChecks のテスト
T010 scanSecrets のテスト（同じファイルの別の describe。書く順をずらす）
```

## Implementation Strategy

- **MVP**: Phase 1〜4（US2 と US1）。合格のジョブが6条件で振り分けられて PR になり、`ci_waiting` で止まる。レポートは仮の本文
- 次に US3（まとめレポート）で原則 VI のレポートの要件を満たす
- US4 は既定の値で P1 が動くので最後。`ship:dev` と本物の GitHub での確認（T023）で締める
