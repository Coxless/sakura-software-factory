---

description: "Task list for 001 foundation"
---

# Tasks: 基盤（foundation）

**Input**: Design documents from `specs/001-foundation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。spec の Independent Test・SC-002〜006 と quickstart が自動テスト（`src/**/*.test.ts`）での確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。

**Organization**: ユーザーストーリーごとにまとめる。US2〜US4 はどれも US1 の品質チェック（テストの実行環境）の上で動くが、互いには独立している（ロガーは設定の型に依存せず `{ level }` だけを受け取る）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US4）
- パスはリポジトリのルートからの相対パス（plan.md の Project Structure）

## 共通の決まり（全タスク）

- コマンドはホストから `workshop exec dev -- bash -c 'cd /project && <command>'` で実行する
- 相対 import は `.ts` 付きで書き、型だけの import は `import type` にする（research R2）
- enum・namespace・パラメータプロパティは使わない（`erasableSyntaxOnly`）
- スキーマは `typebox` 1.x（`import Type from "typebox"`、`typebox/value`）。`@sinclair/typebox` と Zod は使わない
- 想定と違う挙動・エラーに当たったら `docs/journal/` に記録する（CLAUDE.md）

---

## Phase 1: Setup（プロジェクトの初期化）

**Purpose**: パッケージマネージャーと依存を固定した、空のプロジェクトを作る

- [X] T001 `package.json` を作る。`"name": "sakura-software-factory"`、`"private": true`、`"type": "module"`、`"packageManager": "pnpm@12.18.0"`、`"engines": { "node": ">=24" }`、`"devEngines": { "packageManager": { "name": "pnpm", "version": "12.18.0", "onFail": "error" } }`（npm でのインストールを失敗させる。FR-003）。scripts は contracts/commands.md の表のとおり（`check` / `fix` / `lint` / `typecheck` / `test` / `start` / `db:generate` / `db:migrate`）
- [X] T002 pnpm 12 のドキュメントで「インストール時のビルドスクリプトを許可する設定キー」と「完全固定で保存する設定」を確かめ、`pnpm-workspace.yaml` に書く。許可するのは `better-sqlite3` と `esbuild` だけ（research R7）。確かめた結果（キーの名前）を `docs/journal/2026-11-08-001-foundation-specとplan.md` の「まだ分かっていないこと」から結論に移す
- [X] T003 依存を完全固定で入れる（research R1）。runtime: `typebox@1.4.5`（1.4.6 は pnpm 12 の公開後の待ち期間に引っかかったため。journal 参照） `smol-toml@1.9.1` `pino@10.4.0` `better-sqlite3@13.0.3` `drizzle-orm@0.45.4`。dev: `typescript@7.0.2` `@types/node@24.19.2` `@biomejs/biome@2.6.6` `vitest@5.1.0` `drizzle-kit@0.31.11` `pino-pretty@13.2.0` `@types/better-sqlite3@9.6.0`。`package.json` に `^` `~` が残っていないこと、`node -e "require('better-sqlite3')(':memory:')"` が通ることを確かめる。`pnpm-lock.yaml` をコミット対象にする
- [X] T004 [P] `.gitignore` に `node_modules/`、`data/`、`*.db`、`*.db-wal`、`*.db-shm`、`coverage/` を足す

---

## Phase 2: Foundational（全ストーリーの前提）

**Purpose**: 型チェック・lint・テストの各ツールの設定を置く

**⚠️ CRITICAL**: ここが終わるまでストーリーの作業は始めない

- [X] T005 [P] `tsconfig.json` を作る（型チェック専用）。`noEmit: true`、`strict: true`、`module: "nodenext"`、`moduleResolution: "nodenext"`、`target: "esnext"`、`erasableSyntaxOnly: true`、`verbatimModuleSyntax: true`、`allowImportingTsExtensions: true`、`noUncheckedIndexedAccess: true`、`skipLibCheck: true`、`types: ["node"]`。`include` は `src/**/*.ts` とルートの `*.config.ts`
- [X] T006 [P] `biome.json` を作る。フォーマッターと linter（recommended）を有効にし、`node_modules`・`drizzle/`・`pnpm-lock.yaml`・`specs/`・`docs/` を対象から外す。import の整列を有効にする
- [X] T007 [P] `vitest.config.ts` を作る。`test.include: ["src/**/*.test.ts"]`、`environment: "node"`
- [X] T008 `src/` の構成を作る（plan.md の Project Structure: `src/trace/`、`src/queue/`）

**Checkpoint**: ツールの設定がそろい、ストーリーの作業を始められる

---

## Phase 3: User Story 1 - 品質チェックを1コマンドで通す (Priority: P1) 🎯 MVP

**Goal**: `pnpm run check` で lint・フォーマット・型チェック・テストを通し、CI でも同じコマンドを使う

**Independent Test**: 依存を入れた直後に `pnpm run check` が終了コード 0 で終わる。型エラー・lint 違反・失敗するテストをそれぞれ入れると、それぞれ 0 以外で終わる（quickstart.md 1章）

### Implementation for User Story 1

- [X] T009 [US1] 品質チェックの土台が動くことを示す最小のテスト `src/check.smoke.test.ts` を置く（`expect(true).toBe(true)` 程度。US2 以降の本物のテストができたら Phase 7 で消す）
- [X] T010 [US1] `pnpm run check`（`biome ci . && tsc --noEmit && vitest run`）を実行し、終了コード 0 になるまで設定を直す。かかった時間を測り、2分以内であることを確かめる（SC-001）
- [X] T011 [US1] 検出できることを確かめる（SC-002）: 型エラー（`const x: number = "a"`）、lint 違反（未使用の変数）、失敗するテスト（`expect(1).toBe(2)`）をそれぞれ一時的に入れ、`pnpm run check` が 0 以外で終わり、場所・テスト名が出ることを確かめてから元に戻す。あわせて、一時ディレクトリにリポジトリをコピーして `npm install` を実行し、0 以外の終了コードで失敗して pnpm の名前が出ること、`pnpm install` は `devEngines` があっても通ることを確かめる（US1 受入シナリオ4）。npm が `devEngines` を無視するなど想定と違えば、`preinstall` での確認など代わりの方法を決めて spec・plan を直す。結果を `docs/journal/` に記録する
- [X] T012 [P] [US1] `.github/workflows/ci.yml` を作る。`push` と `pull_request` で起動し、`actions/checkout` → `actions/setup-node`（Node 24）→ `corepack enable` → `pnpm install --frozen-lockfile` → `pnpm run check`。権限は `contents: read` だけ

**Checkpoint**: US1 だけで、以降のすべてのコードに同じ品質ゲートがかかる

---

## Phase 4: User Story 2 - 設定ファイルを読み込み、誤りを起動時に知る (Priority: P1)

**Goal**: `factory.toml` を検証して、型付きで凍結した設定を返す。誤りはすべての項目のパスと理由を示して止める

**Independent Test**: 正しい設定・必須の欠落・型違い・未知の項目・範囲外・壊れた TOML を `parseConfig` に渡し、結果を確かめる（`src/config.test.ts`）

### Tests for User Story 2 ⚠️

> テストを先に書き、失敗することを確かめてから実装する

- [X] T013 [US2] `src/config.test.ts` を書く。contracts/factory-toml.md に沿って次を確かめる:
  - 必須項目だけの例（契約の「例」）で成功し、省略した項目に既定値が入る（`budget.timezone` = `"Asia/Tokyo"`、`limits.judge_retries` = 2、`limits.ci_retries` = 2、`limits.max_turns_per_phase` = 40、`limits.job_timeout_minutes` = 60、`limits.ci_wait_timeout_minutes` = 30、`auto_merge.max_diff_lines` = 300、`storage.database_path` = `"data/factory.db"`、`storage.trace_dir` = `"data/traces"`、`log.level` = `"info"`）
  - 返った設定を書き換えようとすると例外になる（深く凍結されている）
  - `models.implementer` がないと、パス `/models/implementer` を含む `ConfigError`
  - `budget.monthly_requests = "3000"` で、パスと期待する型を含むエラー
  - `per_job_requests` > `monthly_requests` でエラー（「monthly_requests 以下」）
  - `monthly_requests = 0` でエラー（「≥ 1」）
  - `[llm] api_key = "x"` で、未知の項目エラーに「環境変数で渡す」案内が付く
  - 綴り間違い（`[budjet]`）で未知の項目エラー
  - `budget.timezone = "Mars/Base"` でエラー
  - `llm.base_url = "http://..."` でエラー（`https://` 必須）
  - `log.level = "verbose"` でエラー
  - 複数の誤りを含む設定で、`ConfigError.issues` にすべてが入る
  - 壊れた TOML で、行・列を含むエラー
  - `storage.database_path` の相対パスが `baseDir` 基準の絶対パスになる
  - `loadConfig("/nonexistent.toml")` がパスを含むエラーになる
  - `requireEnv` が、値があれば返し、なければ名前を含むエラーを投げる
  - リポジトリの `factory.toml` を `loadConfig` で読むと成功する（FR-012）

### Implementation for User Story 2

- [X] T014 [US2] `src/config.ts` に TypeBox のスキーマ `FactoryConfigSchema` を書く。表は `llm` / `models` / `budget` / `limits` / `auto_merge` / `github` / `storage` / `log`。すべての object に `additionalProperties: false`。項目・型・既定値・制約は contracts/factory-toml.md の表をそのまま使う（例: `models.*` は既定値なし・1文字以上、`models.verifier_alt` は省略可、`budget.monthly_requests` / `per_job_requests` は integer ≥ 1、`limits.judge_retries` / `ci_retries` は integer ≥ 0、`github.allowed_users` は1件以上、`log.level` は `trace|debug|info|warn|error|fatal`）。`type FactoryConfig` を `Static` から作る
- [X] T015 [US2] `src/config.ts` に `ConfigError`（`issues: readonly { path: string; message: string }[]`。メッセージは契約の「検証エラーの形」）と `parseConfig(tomlText, baseDir)` を書く。手順: smol-toml で parse（構文エラーは行・列付きの `ConfigError`）→ 既定値を入れる → スキーマ検証（エラーをすべて集める）→ 追加の検証（`per_job_requests <= monthly_requests`、`Intl.DateTimeFormat` で `timezone` を確かめる、`base_url` が `https://` で始まる）→ 未知の項目の名前が `/key|token|secret|password/i` に合えば案内を足す → `storage.*` を `baseDir` 基準の絶対パスにする → 深く `Object.freeze`
- [X] T016 [US2] `src/config.ts` に `loadConfig(path?)`（既定は `process.env.FACTORY_CONFIG ?? "./factory.toml"`、`baseDir` はファイルのディレクトリ。ファイルがなければパスを含む `ConfigError`）と `requireEnv(name)` を書く
- [X] T017 [US2] ルートに `factory.toml` を置く。契約の「例」の必須項目に加え、`[limits]` `[auto_merge]` `[storage]` `[log]` を既定値どおりに書き、各項目に日本語のコメントで意味を書く。URL とモデル名は仮の値である旨と、002 で直す旨をコメントに書く。秘密情報は書かない
- [X] T018 [US2] `pnpm run check` を通す

**Checkpoint**: US2 だけで、後続の機能が型付きの設定を使える

---

## Phase 5: User Story 3 - ジョブと LLM 呼び出しの記録先を用意する (Priority: P1)

**Goal**: 5テーブルをマイグレーションで作り、月とジョブの集計と、二重に取らないジョブの取り出しを提供する

**Independent Test**: `:memory:` か一時ファイルの DB にマイグレーションを当て、各テーブルの読み書き・2回目の適用・集計・取り出しを確かめる（`src/queue/*.test.ts`）

### Tests for User Story 3 ⚠️

> テストを先に書き、失敗することを確かめてから実装する

- [X] T019 [P] [US3] `src/queue/month.test.ts` を書く。`monthRange(now, "Asia/Tokyo")` について: 2026-11-30T15:00:00Z（= 12/01 00:00 JST）は `key: "2026-12"`、`start` がちょうどその時刻、`end` が 2026-12-31T15:00:00Z。2026-11-30T14:59:59.999Z は `"2026-11"`。`"UTC"` を渡すと UTC の月初になる。12月 → 翌年1月をまたぐ
- [X] T020 [P] [US3] `src/queue/db.test.ts` を書く: 一時ディレクトリの存在しないサブディレクトリにある DB ファイルを `openDatabase` で開くとディレクトリとファイルができる。`runMigrations` 後に5テーブル（`jobs` `job_events` `llm_calls` `deployments` `budget`）がある。`PRAGMA journal_mode` が `wal`、`PRAGMA foreign_keys` が 1。2回目の `runMigrations` で既存の行が変わらない。壊れた SQL を含むマイグレーションフォルダーを渡すと例外になり、テーブルが1つも増えていない（失敗時に変更を残さない）
- [X] T021 [P] [US3] `src/queue/schema.test.ts` を書く（マイグレーション済みの `:memory:` DB で）: 各テーブルに1行書いて同じ値で読み出せる。`jobs.status` に12個以外の値を入れると CHECK 違反。同じ `(repo, trigger_comment_id)` の2件目は一意制約違反。`llm_calls.attempt = 0` と `latency_ms = -1` は CHECK 違反。`llm_calls.job_id = NULL` は書ける。存在しない `job_id` の `job_events` は外部キー違反。`budget.monthly_limit = 0` は CHECK 違反。1つのジョブのイベントを3件書くと `ORDER BY id` で書いた順に読める
- [X] T022 [P] [US3] `src/queue/llm-calls.test.ts` を書く: 月の境目の前後（JST）に呼び出しを置き、`countLlmCallsInMonth` が今月分だけを数える。`status = "error"` の行も数える。`countLlmCallsForJob` がそのジョブの行だけを数える。1,000行を入れた状態で両方の集計が1秒以内（SC-005）
- [X] T023 [P] [US3] `src/queue/jobs.test.ts` を書く: `queued` が3件あると `claimNextQueuedJob` は `created_at`（同じなら `id`）が最も古い1件を `planning` にして返し、`started_at` と `updated_at` に `now` が入る。続けて呼ぶと次の1件を返す。`queued` がなければ `undefined`。同じ DB ファイルを開いた2つの接続から交互に呼んでも同じジョブを二度返さない

### Implementation for User Story 3

- [X] T024 [US3] `src/queue/schema.ts` に Drizzle（`drizzle-orm/sqlite-core`）のテーブルと列挙値を書く。data-model.md をそのまま写す:
  - `JOB_STATUSES = ["queued", "planning", "implementing", "testing", "judging", "pr_opened", "ci_waiting", "merged", "deploying", "deployed", "rolled_back", "failed"] as const`、`TERMINAL_JOB_STATUSES = ["deployed", "rolled_back", "failed"]`、`JOB_EVENT_TYPES = ["state_changed", "note", "error"]`、`LLM_ROLES = ["planner", "implementer", "verifier"]`、`LLM_CALL_STATUSES = ["ok", "error"]`、`DEPLOYMENT_STATUSES = ["running", "succeeded", "failed"]`
  - `jobs`: 列は data-model.md の表のとおり。`status` は既定 `queued` で CHECK、`judge_retries` / `ci_retries` は既定 0、一意 `(repo, trigger_comment_id)`、索引 `(status, created_at)`
  - `jobEvents`: `job_id` は NOT NULL の外部キー、`type` は CHECK、`detail` は JSON 文字列、索引 `(job_id, id)`
  - `llmCalls`: `job_id` は NULL 可の外部キー、`phase` は CHECK なし、`role` と `status` は CHECK、「CHECK: `attempt >= 1`、`latency_ms >= 0`」、索引 `(created_at)` と `(job_id)`
  - `deployments`: `job_id` は NULL 可、`status` は CHECK、`rolled_back` は boolean モードで既定 0、索引 `(status, created_at)`
  - `budget`: 主キー `month`（`YYYY-MM`）、「CHECK: `monthly_limit >= 1`」、`intake_stopped_at` は NULL 可
  - 時刻の列はすべて `integer`（UTC ミリ秒）。各テーブルの select / insert の型（`Job` など）を export する
- [X] T025 [US3] `drizzle.config.ts` を作り（dialect `sqlite`、schema `./src/queue/schema.ts`、out `./drizzle`）、`pnpm run db:generate` で `drizzle/` に最初のマイグレーションを作る。生成された SQL に CHECK・一意制約・索引・外部キーが入っていることを目で確かめる
- [X] T026 [US3] `src/queue/db.ts` に `openDatabase(path)` と `runMigrations(db, migrationsFolder?)` を書く（contracts/module-api.md）。`openDatabase`: `:memory:` 以外なら親ディレクトリを作る → better-sqlite3 で開く → `journal_mode = WAL`・`foreign_keys = ON`・`busy_timeout = 5000`・`synchronous = NORMAL` → drizzle で包んで `{ db, sqlite, close }` を返す。`runMigrations`: 既定のフォルダーはリポジトリの `drizzle/`（`import.meta.dirname` から解決）。drizzle の migrator が失敗時に巻き戻さないと T020 で分かった場合は、自前の即時トランザクションで包む（research R6）
- [X] T027 [P] [US3] `src/queue/month.ts` に `monthRange(now, timeZone)` を書く（research R5）。`Intl.DateTimeFormat` で `timeZone` における年月を求め、その月の1日 0:00 と翌月1日 0:00 の UTC ミリ秒を返す。外部ライブラリは使わない
- [X] T028 [US3] `src/queue/llm-calls.ts` に `countLlmCallsInMonth(db, now, timeZone)`（`monthRange` の `[start, end)` で `created_at` を数える）と `countLlmCallsForJob(db, jobId)` を書く
- [X] T029 [US3] `src/queue/jobs.ts` に `claimNextQueuedJob(db, now)` を書く（research R9）。即時トランザクションの中で `UPDATE jobs SET status = 'planning', started_at = :now, updated_at = :now WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1) RETURNING *` を実行する
- [X] T030 [US3] `pnpm run check` を通す

**Checkpoint**: US3 だけで、002 の予算ゲートと 007 のキューが使う記録先がそろう

---

## Phase 6: User Story 4 - 構造化ログを出す (Priority: P2)

**Goal**: 1行1件の JSON ログを出し、秘密情報を項目名と値の両方で伏せる

**Independent Test**: 書き込み先をメモリに差し替えたロガーで出力を確かめる（`src/log.test.ts`、`src/trace/mask.test.ts`）

### Tests for User Story 4 ⚠️

- [X] T031 [P] [US4] `src/trace/mask.test.ts` を書く: `Bearer abc.def` → `Bearer [REDACTED]`。`ghp_` `ghs_` `github_pat_` で始まるトークン → `[REDACTED]`。`-----BEGIN ... PRIVATE KEY-----` から `-----END ... PRIVATE KEY-----` までのブロック → `[REDACTED]`。秘密情報を含まない文字列は変わらない
- [X] T032 [P] [US4] `src/log.test.ts` を書く（書き込み先はメモリのストリーム）: 1行が JSON で `time` `level` `msg` を含む。`logger.child({ job_id: 42 })` の出力に `job_id: 42` が含まれる。`{ headers: { authorization: "Bearer x" } }`、`{ api_key: "x" }`、`{ token: "x" }` の値が出力に現れない。`msg` に含めた `ghp_xxx`、`logger.error({ err: new Error("token ghp_xxx") })` のエラー文、`{ a: { b: ["Bearer x"] } }` のような入れ子の値が出力に現れない（SC-006）。循環参照を含むオブジェクトを出しても例外にならない。`level = "warn"` のとき `info` が出ない

### Implementation for User Story 4

- [X] T033 [P] [US4] `src/trace/mask.ts` に `maskSecrets(text)` を書く（research R8 の2の形）
- [X] T034 [US4] `src/log.ts` に `createLogger({ level }, destination?)` を書く（contracts/module-api.md。`config.ts` を import しない）。pino を使い、`redact`（`censor: "[REDACTED]"`）のパスは research R8 の1の一覧、`serializers.err` は `pino.stdSerializers.err`、`formatters.log` でオブジェクト全体を再帰的にたどって（入れ子のオブジェクト・配列も。循環参照は飛ばす）文字列に `maskSecrets` をかけ、`hooks.logMethod` でメッセージ文字列にも `maskSecrets` をかける。`Logger` と `LogLevel` の型を export する
- [X] T035 [US4] `pnpm run check` を通す

**Checkpoint**: US4 だけで、後続の機能が文脈付きの安全なログを出せる

---

## Phase 7: Polish & Cross-Cutting（起動処理と仕上げ）

**Purpose**: US2〜US4 をつなぐ起動処理と専用コマンド、仕上げ

- [X] T036 `src/main.ts` を書く: `loadConfig()` → `createLogger({ level: config.log.level })` → `openDatabase(config.storage.database_path)` → `runMigrations` → `logger.info("factory started")` → DB を閉じて終了。`ConfigError` やマイグレーションの失敗は `issues` を含めてログ（ロガーができる前の失敗は標準エラー）に出し、終了コード 1（contracts/commands.md）
- [X] T037 `src/migrate.ts` を書く: 設定を読み、DB を開いてマイグレーションを当て、適用の結果をログに出して終了コード 0。失敗時は終了コード 1
- [X] T038 `src/check.smoke.test.ts`（T009）を消し、`pnpm run check` を通す
- [X] T039 quickstart.md の 1〜4 章を上から順に実行し、期待どおりか確かめる。`sqlite3` CLI が Workshop にない場合は quickstart の代わりの手順（`node -e` で better-sqlite3 から問い合わせる）を使う。食い違いがあれば quickstart.md か実装を直す
- [X] T040 [P] `docs/journal/` に、実装中の試行錯誤（pnpm 12 の設定キー、TypeScript 7・TypeBox 1.x・drizzle の migrator で当たったことなど）をまとめる
- [X] T041 [P] 実装の結果が設計とずれていないか確かめる（8章の構成は analyze のあとに更新済み）。ずれていれば `docs/design/03`（5章・7章・8章）を同じ変更で直す

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup（Phase 1）**: 依存なし
- **Foundational（Phase 2）**: Setup のあと。全ストーリーを止める
- **US1（Phase 3）**: Foundational のあと。テストの実行環境を確かめるので、US2〜US4 より先に終える
- **US2・US3・US4（Phase 4〜6）**: US1 のあと。互いに独立していて、どの順でも並行でもよい
- **Polish（Phase 7）**: US2・US3・US4 がすべて終わったあと（`main.ts` が3つをつなぐ）

### Within Each User Story

- テストを先に書いて失敗を確かめる → 実装 → `pnpm run check`
- US3: `schema.ts`（T024）→ マイグレーションの生成（T025）→ `db.ts`（T026）→ `llm-calls.ts` / `jobs.ts`。`month.ts`（T027）は独立
- US4: `mask.ts`（T033）→ `log.ts`（T034）

### Parallel Opportunities

- Phase 1: T004 は T001〜T003 と並行
- Phase 2: T005・T006・T007 は並行
- US1: T012（CI）は T009〜T011 と並行
- US2・US3・US4 は、US1 のあとならストーリー単位で並行
- US3 のテスト T019〜T023 は並行。実装は T027 だけが他と並行
- US4 の T031・T032・T033 は並行

## Parallel Example: User Story 3

```bash
# テストをまとめて書く（すべて別ファイル）
Task: "T019 src/queue/month.test.ts"
Task: "T020 src/queue/db.test.ts"
Task: "T021 src/queue/schema.test.ts"
Task: "T022 src/queue/llm-calls.test.ts"
Task: "T023 src/queue/jobs.test.ts"

# schema → 生成 → db のあと、残りを進める
Task: "T027 src/queue/month.ts"        # いつでも
Task: "T028 src/queue/llm-calls.ts"    # T026 のあと
Task: "T029 src/queue/jobs.ts"         # T026 のあと
```

## Implementation Strategy

### MVP First（US1 だけ）

1. Phase 1・2 を終える
2. Phase 3（US1）を終える
3. **止めて確かめる**: `pnpm run check` が通り、誤りを3種類とも検出し、CI でも通る
4. ここで一度コミットしてよい（以降のすべてのコードに品質ゲートがかかる）

### Incremental Delivery

1. Setup ＋ Foundational ＋ US1 → 品質ゲート
2. US2 → 型付きの設定（002 の予算ゲートが使える）
3. US3 → 記録先（002 の `llm_calls` 記録、007 のキュー）
4. US4 → ログ
5. Polish → `pnpm start` と `pnpm run db:migrate` で起動処理が通る

M0（11/08〜11/11）で 002 に進むため、US3 の `llm_calls` 周り（T024〜T028）を優先する。US4 は遅れたら 002 と並行してよい。
