---

description: "Task list for 011 status-dashboard"
---

# Tasks: 計測と状況ページ（status-dashboard）

**Input**: Design documents from `specs/011-status-dashboard/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。SC-002（手で数えた値と一致）・SC-004（目印の文字列が出ない）・SC-006（予算を使わない）が自動テストでの確認を前提にしているため。テストを先に書いて失敗を確かめてから実装する。

**Organization**: US1（数値）と US4（認証）が P1、US2（一覧）と US3（JSON）が P2。US1 の集計が土台で、US2・US3 はその上に乗る。US4 は配備物だけで、コードの US とは独立して進められる。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US4）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- 状況ページは DB を読むだけ。`insert`・`update`・`delete` を書かない。LLM を呼ばない
- 出してはいけない列（contracts/http-status.md の「出さないもの」）は SELECT にも入れない
- 想定と違う挙動・エラーに当たったら `docs/journal/2026-11-14-011-status-dashboard.md` に記録する

---

## Phase 1: Setup

- [X] T001 `src/status/` を作り、`src/status/schema.ts` に data-model.md の StatusSnapshot を TypeBox で定義する（`Rate` は `ratio: number | null`、`numerator`・`denominator` は 0 以上の整数。内訳は `{ key: string, count: integer }` の配列。一覧の行は data-model.md の列だけ。`additionalProperties: false`）。型 `StatusSnapshot` を `Static` で出す

## Phase 2: Foundational

- [X] T002 `src/status/testing.ts` に、テスト用の記録を入れる関数（ジョブ・ジョブのイベント（`ci_result`）・LLM 呼び出し・工程の実行・デプロイ・予算の行）を作る。`:memory:` の DB に `runMigrations` を当てて返す `openTestDb()` も置く（既存の `src/queue/testing.ts` にあればそれを使う）

**Checkpoint**: スキーマとテスト用の記録が揃い、集計のテストを書ける

---

## Phase 3: User Story 1 - 今月の数値を1画面で見る (Priority: P1) 🎯 MVP

**Goal**: 5つの数値（消費・成功率・平均処理時間・CI 初回通過率・デプロイ成功率）を `GET /status` の HTML で出す

**Independent Test**: 今月と先月の記録を入れた DB で `collectStatus` と `GET /status` を呼び、数値が手で数えた値と一致する

### Tests for User Story 1

- [X] T003 [P] [US1] `src/status/collect.test.ts`: 消費（今月 412 件・上限 3000・残り 2588、役割別・モデル別・ジョブ以外・トークン・失敗の種類別、先月の呼び出しは数えない、月の区切りは `Asia/Tokyo`）、成功率（`deployed` 6・`rolled_back` 1・`failed` 3 → 6/10、`failure_reason` の種類別。`"ci_failed: ..."` は `ci_failed`、知らない種類は `other`）、処理時間（平均と中央値、`started_at` がないものは除く）、CI 初回通過率（`attempt = 1` の `ci_result` だけ、4/5）、デプロイ成功率（8/10、ロールバック 1）、分母 0 で `ratio: null`、受付停止の時刻、`in_progress` の件数。結果が `StatusSnapshot` のスキーマに合う（`Value.Check`）
- [X] T004 [P] [US1] `src/status/render.test.ts`: 5つの数値の見出しと値（`60.0%（6/10）`・`データなし`・時間の表記）、受付停止の表示、リポジトリ名などに入れた `<script>` がエスケープされて出る、`<script` タグがない、CSP のハッシュと `<style>` の中身が一致する（`styleHash()`）
- [X] T005 [P] [US1] `src/http/app.test.ts` に `/status` のテストを足す: 200・`text/html`、見出し（`Cache-Control: no-store`・`X-Content-Type-Options`・`Referrer-Policy`・`X-Frame-Options: DENY`・`Content-Security-Policy`）、DB を閉じたあとは 500 で本文が `{"error":"internal_error"}`、`POST /status` は 404、`/status` を開いても `llm_calls` と `budget` の行数が変わらない（SC-006）

### Implementation for User Story 1

- [X] T006 [US1] `src/status/collect.ts` に `collectStatus(db, { now, timeZone, monthlyLimit })` を実装する（research R4・R5・R9）。月は `monthRange`。消費は `llm_calls.created_at` が `[start, end)`、ジョブ・デプロイは `finished_at` が `[start, end)`。CI は `job_events` の `type = 'note'` かつ `json_extract(detail, '$.kind') = 'ci_result'` かつ `json_extract(detail, '$.attempt') = 1` を `job_id` ごとに1件。失敗の種類は `FAILURE_KINDS`（`src/pipeline/report.ts`）で照らす。分母 0 は `ratio: null`
- [X] T007 [US1] `src/status/render.ts` に `renderStatusHtml(snapshot)` と `styleHash()` を実装する（contracts/http-status.md の HTML の節）。`hono/html` の `html` タグだけを使い `raw()` は使わない。CSS は定数1つ、`styleHash()` はその SHA-256 の base64。時刻は `snapshot.month.time_zone` で `YYYY-MM-DD HH:mm`
- [X] T008 [US1] `src/http/app.ts` に `GET /status` を足す。`AppDeps` に `db: Db` と `status: { timeZone, monthlyLimit }` を足し（`now` は差し替え可能）、見出しは contracts/http-status.md のとおり。失敗はログ（`status failed`）と 500。`src/main.ts` の `createApp` 呼び出しに `db` と `config.budget` の値を渡す（既存の `app.test.ts`・`main.test.ts`・`server.test.ts` の呼び出しも合わせる）

**Checkpoint**: `GET /status` で5つの数値が出る

---

## Phase 4: User Story 2 - 最近のジョブと工程の実行を見る (Priority: P2)

**Goal**: 最近のジョブ（20）・工程の実行（30）・デプロイ（10）を新しい順に出す。出してはいけない列を出さない

**Independent Test**: 件数より多い記録を入れ、新しい順に決まった件数だけ出ること、目印の文字列が応答に出ないことを確かめる

### Tests for User Story 2

- [X] T009 [P] [US2] `src/status/collect.test.ts` に一覧のテストを足す: ジョブ 30 件 → 新しい順に 20 件、`requests` はジョブごとの `llm_calls` の件数、`duration_ms`（片方の時刻がなければ null）、工程の実行 40 件 → 30 件で `outcome: null` は実行中、デプロイ 15 件 → 10 件で `commit` は先頭 12 文字
- [X] T010 [P] [US2] `src/http/app.test.ts` に SC-004 のテストを足す: `jobs.instruction`・`failure_reason` の後ろの文・`requested_by`・`agent_runs.error`・`trace_path`・`deployments.error`・`image_tag`・`rolled_back_to`・`llm_calls.error` に目印の文字列を入れ、HTML と `?format=json` のどちらにも出ない

### Implementation for User Story 2

- [X] T011 [US2] `src/status/collect.ts` に一覧（data-model.md の JobRow・RunRow・DeployRow の列だけを SELECT）を足す
- [X] T012 [US2] `src/status/render.ts` に3つの表を足す（実行中の表示、終わり方・判定・失敗した段階、ロールバックの有無、revert PR の番号）

**Checkpoint**: 一覧が出て、出してはいけない値が出ない

---

## Phase 5: User Story 3 - 同じ数値を機械で読める形で取り出す (Priority: P2)

**Goal**: `?format=json` で StatusSnapshot を返す。開発用の CLI でも同じ集計を出す

**Independent Test**: JSON がスキーマに合い HTML と同じ数値であること、CLI が開発用の DB を読み取り専用で開くことを確かめる

### Tests for User Story 3

- [X] T013 [P] [US3] `src/http/app.test.ts`: `?format=json` は `application/json` でスキーマに合う、`consumption.requests` が HTML の値と同じ、`?format=xml` は HTML
- [X] T014 [P] [US3] `src/status-dev.test.ts`: 一時ディレクトリの設定と DB で、JSON を標準出力に出す・`--html` で HTML を出す・DB がなければ終了コード 1 で作らない・DB の中身が変わらない

### Implementation for User Story 3

- [X] T015 [US3] `src/http/app.ts` に `?format=json` を足す（research R7）
- [X] T016 [US3] `src/status-dev.ts` を作る: 設定は `FACTORY_CONFIG`、なければ `./factory.dev.toml`。DB を `readonly`・`fileMustExist` で開き（マイグレーションしない）、`collectStatus` の結果を JSON（`--html` で HTML）で出す。`package.json` に `"status:dev": "node src/status-dev.ts"` を足す

**Checkpoint**: 画面・JSON・CLI で同じ数値が取れる

---

## Phase 6: User Story 4 - 認証なしでは見られない (Priority: P1)

**Goal**: 公開のドメインで `/status` を Caddy の Basic 認証で守り、認証の値がなければ配備を止める

**Independent Test**: `deploy:lint` と `deploy:rehearsal` で、401・200 と、値が空なら `setup.sh` が止まることを確かめる

- [X] T017 [P] [US4] `deploy/Caddyfile` を contracts/caddy.md のとおりに直す（`handle /status` に `basic_auth`、`@factory` から `/status` を外す）。`deploy/caddy.env.example` に `STATUS_USER`・`STATUS_PASSWORD_HASH`（単一引用符の注記と `caddy hash-password` の使い方）を足す
- [X] T018 [P] [US4] `deploy/scripts/setup.sh` の `check_secret_file /etc/caddy/caddy.env` に `STATUS_USER STATUS_PASSWORD_HASH` を足す
- [X] T019 [US4] `deploy/scripts/lint.sh` の `caddy validate` に偽の `STATUS_USER`・`STATUS_PASSWORD_HASH`（固定の検査用ハッシュ）を渡す。`STATUS_PASSWORD_HASH` が空のときに `caddy validate` が失敗するかを確かめ、journal に記録する
- [X] T020 [US4] `deploy/rehearsal/run.sh`: caddy.env に `STATUS_USER=rehearsal` と、箱の中の `caddy hash-password` で作ったハッシュ（単一引用符で囲む）を書く。確認を足す: `/status` は認証なしで 401、誤ったパスワードで 401、正しい認証で 200 かつ HTML、`/healthz` は認証なしで 200 のまま
- [X] T021 [US4] `deploy/README.md` に「状況ページ」の節（ハッシュの作り方 `caddy hash-password`、単一引用符、caddy.env への書き方、`setup.sh` の流し直し、確かめ方の curl）を足す

**Checkpoint**: 公開のドメインで認証なしの `/status` が返らない

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T022 [P] 設計ドキュメントを直す（plan.md の「設計ドキュメントとの差分」）: `docs/design/03`（5章の公開するパスとドメイン・TLS、7章の数値の定義・出さないもの・認証、8章の `src/status/`・`status-dev.ts`）、`specs/006-vps-ops/contracts/caddy.md`（環境変数と Caddyfile を今の形に）
- [X] T023 [P] `docs/journal/2026-11-14-011-status-dashboard.md` に、公開範囲を決めた経緯（集計だけの公開 → 認証付きに決めた理由）、認証を Caddy に置いた理由、ハッシュの `$` の扱い、想定と違った挙動を書く
- [X] T024 `pnpm run check`・`pnpm run deploy:lint`・`pnpm run deploy:rehearsal` を通す。quickstart.md の 1〜3 を上から流し、食い違いがあれば quickstart.md か実装を直す
- [X] T025 SC-003 を確かめる: 3,000 件の呼び出し・500 件のジョブを入れた DB で `collectStatus` が 1 秒以内（`collect.test.ts` に時間の上限つきのテストを1つ足す）

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1（T003〜T008）→ US2・US3（どちらも US1 の `collect.ts`・`render.ts`・`app.ts` に足すので順に）
- US4（T017〜T021）はコードに依存しない。いつでも進められる
- Polish は全ストーリーのあと

### Parallel Opportunities

- T003・T004・T005（別ファイルのテスト）
- T009・T010、T013・T014
- T017・T018（US1 と並行してよい）
- T022・T023

## Implementation Strategy

1. MVP: Phase 1〜3（US1）で5つの数値が出る
2. US2・US3 で一覧と JSON・CLI を足す
3. US4 で公開の準備（VPS解禁の 12-03 までに必要）
4. Polish で設計ドキュメント・journal・検査
