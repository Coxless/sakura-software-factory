---

description: "Task list for 002 llm-budget-gate"
---

# Tasks: LLM層と予算ゲート（llm-budget-gate）

**Input**: Design documents from `specs/002-llm-budget-gate/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。spec の Independent Test・SC-002〜007 と quickstart の表が自動テスト（`src/**/*.test.ts`、偽の `fetch`）での確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。スモークテスト（実機）だけは手動。

**Organization**: ユーザーストーリーごとにまとめる。ただし US1（スモークテスト）も原則 V によりゲートを通すため、ゲートの最小の中核（予算の確認・1回の試行・記録）を Phase 2 に置く。US1 を最初に終わらせ、2026-11-11 までに Pi を続けるか切り替えるかを決める（実装計画 M0）。US2〜US4 はゲートの中核を仕上げる段階で、US5 は後続機能向けの偽の LLM の仕上げ。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）
- パスはリポジトリのルートからの相対パス（plan.md の Project Structure）

## 共通の決まり（全タスク）

- コマンドはホストから `workshop exec dev -- bash -c 'cd /project && <command>'` で実行する
- 相対 import は `.ts` 付きで書き、型だけの import は `import type` にする。enum・namespace・パラメータプロパティは使わない（`erasableSyntaxOnly`）
- スキーマは `typebox` 1.x（`import Type from "typebox"`、`typebox/value`）。Zod は使わない
- Pi は `@earendil-works/*` だけを使う。旧 API（`@earendil-works/pi-ai/compat`、`registerApiProvider`）と旧名 `@mariozechner/*` の情報は使わない
- 自動テストで さくらのAI Engine を呼ばない。テストの LLM は `src/llm/testing.ts` の偽の `fetch` だけ
- 想定と違う挙動・エラーに当たったら `docs/journal/YYYY-MM-DD-002-llm-budget-gate-実装.md` に記録する（CLAUDE.md）。APIキーは書かない
- journal のファイル名の `YYYY-MM-DD` は、書いた日の実際の日付にする（同じ日の同じ話題は1つのファイルに追記する）

---

## Phase 1: Setup（依存と設計ドキュメント）

**Purpose**: Pi を入れ、計画で決めた差分を設計ドキュメントに先に反映する

- [X] T001 `docs/design/03_アーキテクチャと技術スタック.md` を plan.md の「設計ドキュメントとの差分」に合わせて直す: 7章の `llm_calls` の列に `error_kind` を足す（`transient` / `permanent` / `timeout` / `aborted`）、5章「開発ツール・運用」の設定の行に「LLM のリトライ上限・待ち時間の上限・応答の時間の上限」を足す、8章の `llm/` に `smoke.ts`（スモークテストの確認項目）と `testing.ts`（偽の fetch）を、`src/` に `smoke-llm.ts` を足す。決定事項と根拠だけを書き、変更履歴は書かない
- [X] T002 依存を完全固定で入れる（research R1）: `pnpm add @earendil-works/pi-ai@1.5.0 @earendil-works/pi-agent-core@1.5.0`。`package.json` に `^` `~` がないこと、`pnpm-workspace.yaml` に `minimumReleaseAgeExclude` が勝手に足されていないことを確かめる（足されたら除外を消し、待ち期間を満たす版を選び直して journal に記録する）。推移的な依存のビルド許可を求められたら、必要なものだけ `allowBuilds` に足す
- [X] T003 [P] `package.json` の scripts に `"smoke:llm": "node src/smoke-llm.ts"` を足す（contracts/commands.md）。`pnpm run check` には含めない

---

## Phase 2: Foundational（ゲートの最小の中核）

**Purpose**: すべてのストーリーが使う、設定・記録の列・提供元・偽の fetch・ゲートの中核（予算の確認 → 1回の試行 → 記録、再試行なし）を作る

**⚠️ CRITICAL**: このフェーズが終わるまでユーザーストーリーに入らない

### 設定

- [X] T004 `src/config.test.ts` に、`[llm]` の追加項目のテストを足す（contracts/factory-toml.md）: 省略時に `max_attempts = 3`・`max_retry_delay_seconds = 60`・`request_timeout_seconds = 300` が入る／`max_attempts` は「1〜10」、`max_retry_delay_seconds` は「1〜600」、`request_timeout_seconds` は「10〜1800」で範囲外はエラー（項目のパス付き）／未知の項目はエラー。失敗を確かめる
- [X] T005 `src/config.ts` の `[llm]` のスキーマに3項目を既定値つきで足し、T004 を通す。`factory.toml` の `[llm]` に3項目をコメント付きで書き足し、`specs/001-foundation/contracts/factory-toml.md` の `[llm]` の表にも3項目と環境変数 `SAKURA_AI_API_KEY` を追記する

### 記録の列

- [X] T006 `src/queue/schema.test.ts` に `error_kind` のテストを足す: `LLM_ERROR_KINDS = ["transient", "permanent", "timeout", "aborted"]` 以外の値は CHECK で拒否／`status = 'ok'` なのに `error_kind` があると拒否／`status = 'error'` なのに `error_kind` が NULL だと拒否（data-model の「`status = 'ok'` ⇔ `error_kind IS NULL`」）。失敗を確かめる
- [X] T007 `src/queue/schema.ts` の `llmCalls` に `error_kind: text("error_kind", { enum: LLM_ERROR_KINDS })`（NULL 可）と、CHECK 2つ（値の範囲、`(status = 'ok') = (error_kind IS NULL)`）を足し、`LLM_ERROR_KINDS` と型 `LlmErrorKind` を export する。`pnpm run db:generate` でマイグレーションを `drizzle/` に作り、生成された SQL を読んで既存の行を失わないこと（表の作り直しなら INSERT ... SELECT で移していること）を確かめる。既存の `status = 'error'` の行は `error_kind = 'permanent'` で移すよう、生成された SQL を必要に応じて直す（data-model のマイグレーション）。T006 と `src/queue/db.test.ts` を通す

### 提供元

- [X] T008 [P] `src/llm/provider.test.ts` を書く: `createSakuraModels(config)` が `factory.toml` の `[models]` の全モデル名（`verifier_alt` は設定があるときだけ）を `sakura` の提供元で持つ／各モデルの `baseUrl` が `[llm].base_url`、`api` が `"openai-completions"`、`compat` が `DEFAULT_SAKURA_COMPAT`／`options.compat` で一部だけ上書きできる／`modelForRole(models, config, "implementer")` が `config.models.implementer` のモデルを返す／退避先に自動で切り替えない（存在しないモデル名なら例外）。失敗を確かめる
- [X] T009 `src/llm/provider.ts` を書いて T008 を通す（research R2・R3、contracts/module-api.md）: `SAKURA_PROVIDER_ID = "sakura"`、`SAKURA_API_KEY_ENV = "SAKURA_AI_API_KEY"`、`DEFAULT_SAKURA_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, supportsUsageInStreaming: true, supportsStrictMode: false, maxTokensField: "max_tokens" }`、`createSakuraModels(config, { compat? })` は `createProvider({ id, name, baseUrl, auth: { apiKey: envApiKeyAuth("さくらのAI Engine", [SAKURA_API_KEY_ENV]) }, models, api: openAICompletionsApi() })`（`@earendil-works/pi-ai/api/openai-completions.lazy`）を `createModels().setProvider()` する。モデルは `reasoning: false`、`input: ["text"]`、`cost` はすべて 0、`contextWindow: 131072`、`maxTokens: 8192`（定数。スモークテストで分かったら直す）。`modelForRole(models, config, role)` は `LlmRole` に加えて `"verifier_alt" | "fallback"` も受け取れるようにする（スモークテストの `--role` 用）

### 偽の LLM（最小）

- [X] T010 [P] `src/llm/testing.ts` に `createFakeLlm(responses)` を書く（research R13、contracts/module-api.md）。この段階では `{ text, usage? }` と `{ toolCall: { name, args }, text?, usage? }` の2種類だけ: 要求の本文の `stream` が true なら OpenAI互換の SSE（`data: {"choices":[{"delta":...}]}` の列 → `finish_reason` → `usage` のチャンク → `data: [DONE]`）を、false なら `chat.completion` の JSON を返す。受け取った要求の `model`・`messages`・`tools`・`stream` を `requests` に積む。仕込みが尽きたら `fetch` が `new Error("fake LLM: no more responses")` を投げる。`remaining()` を持つ。あわせて `createTestGateDeps({ responses, config? })` を書く: `:memory:` の DB に `runMigrations`、テスト用の設定（`parseConfig` でサンプルから作る）、`createSakuraModels`、偽の `fetch`、待たない `sleep`、固定できる `now`、手動で発火できる `timeoutSignal`（テストから `fireTimeout()` で中止する）、黙ったロガー。`process.env.SAKURA_AI_API_KEY` が要る場合は `"test-key"` を渡す方法（`streamSimple` の `apiKey` オプションか環境変数）を pi-ai の挙動を見て決める

### ゲートの中核（再試行なし）

- [X] T011 `src/llm/budget.test.ts` を書く: `checkBudget` が今月の消費 < `monthly_requests` かつ（ジョブありなら）ジョブの消費 < `per_job_requests` で `undefined`、月が上限ちょうどで `scope: "monthly"`、ジョブが上限ちょうどで `scope: "job"`（`limit` と `used` 付き）、`jobId: null` は月だけで判断する／`ensureBudgetMonth` が同じ月で2回呼んでも1行だけ作り、`monthly_limit` に設定値を写す。失敗を確かめる
- [X] T012 `src/llm/budget.ts` を書いて T011 を通す（research R11、contracts/module-api.md）: `BudgetExceededError`（`scope` / `limit` / `used`、メッセージは `budget_exceeded:<scope> limit=<n> used=<n>`）、`checkBudget(db, config, jobId, now)`（001 の `countLlmCallsInMonth`・`countLlmCallsForJob` を使う）、`ensureBudgetMonth(db, config, now)`（`monthRange` の `key` で `INSERT ... ON CONFLICT(month) DO NOTHING`）
- [X] T013 `src/llm/stream.test.ts` に中核のテストを書く: `runGated` が予算の確認 → 試行 → `llm_calls` に1件（`job_id`・`phase`・`role`・`model`・`attempt = 1`・`status = 'ok'`・`error_kind = NULL`・`input_tokens`・`output_tokens`・`latency_ms >= 0`・`created_at` は試行の開始時刻）を書いて値を返す／予算切れなら試行関数を呼ばず、記録もせず `BudgetExceededError` を投げる／`createGatedStreamFn(deps, ctx)` を `models.streamSimple` の代わりに呼ぶと、偽の LLM のテキスト応答が `AssistantMessage` で返り、イベントが `start` → … → `done` の順に流れる／内側に `maxRetries: 0` と ゲートの `fetch` が渡っている（偽の LLM の `requests` が1件）。失敗を確かめる
- [X] T014 `src/llm/stream.ts` に中核を書いて T013 を通す（research R4・R7・R9、contracts/module-api.md）: `CallContext`、`GateDeps`、`AttemptOutcome`（`GateDeps` は `timeoutSignal?: (ms) => AbortSignal` を持ち、既定は `AbortSignal.timeout`）、`runGated(deps, ctx, model, attempt)`（この段階では1回だけ試行。試行ごとに `checkBudget` → `ensureBudgetMonth` → 試行 → 記録を1回の INSERT）、`createGatedStreamFn(deps, ctx): StreamFn`（`deps.models.streamSimple(model, context, { ...options, maxRetries: 0, fetch: 観測用 fetch, signal, timeoutMs })` を呼び、イベントを `done` か `error` まで溜め、成功なら `createAssistantMessageEventStream()` に順に流して終える。失敗なら `stopReason: "error"`・`errorMessage` 付きの `error` イベント1つ。予算切れも `error` イベントで返し、`errorMessage` は `BudgetExceededError` のメッセージ）、`getBudgetExceeded(message)`（`errorMessage` の接頭辞から復元）。観測用 fetch は `deps.fetch ?? globalThis.fetch` を包み、応答の状態コードと `retry-after-ms`・`retry-after`・`x-should-retry` を試行ごとに覚える

**Checkpoint**: 偽の LLM で「予算の確認 → 1回送る → 記録」が通る。ここから US1 に入れる

---

## Phase 3: User Story 1 - さくらのAI Engine で実装役のツール呼び出しを実機で確かめる (Priority: P1) 🎯 MVP

**Goal**: `pnpm run smoke:llm` で、Pi 経由と素の HTTP の両方で6項目（a〜f）の合否を出し、Pi を続けるか切り替えるかを決める

**Independent Test**: 偽の fetch で smoke.ts の確認項目が合否を正しく判定すること（自動）、実機で `SAKURA_AI_API_KEY` を渡して実行し、合否と `requests` が出て `llm_calls` に同数の行（`phase = 'smoke'`, `job_id IS NULL`）が増えること（手動）

### Tests for User Story 1

- [X] T015 [P] [US1] `src/llm/smoke.test.ts` を書く（research R15）: 偽の LLM に「`pong` のテキスト」「`get_weather({city:"東京"})` のツール呼び出し」「`晴れです` のテキスト」を仕込むと6項目すべて合格・`requests = 3`・`llm_calls` に3行（`phase = 'smoke'`、`job_id` NULL）／ツール呼び出しの代わりに `<tool_call>{"name":"get_weather",...}</tool_call>` を本文に含むテキストを返すと (b) と (e) が不合格で `detail` にマスク済みの本文／引数が `{ location: "Tokyo" }` なら (c) が不合格／usage がないと (f) が不合格／`mode: "raw"`（偽の fetch の SSE 応答。ツール呼び出しの引数を複数の `delta.tool_calls` に分けて返しても組み立てられる）と `mode: "raw-nostream"`（JSON 応答）でも同じ3パターンが同じ判定になる／`raw` の要求の本文が `stream: true`・`stream_options.include_usage: true`、`raw-nostream` が `stream: false` であること／素の HTTP の呼び出しも `llm_calls` に記録される。失敗を確かめる

### Implementation for User Story 1

- [X] T016 [US1] `src/llm/smoke.ts` を書いて T015 を通す（research R14・R15、data-model の SmokeReport）: `runSmoke(deps, { role, mode: "pi" | "raw" | "raw-nostream", compat? }): Promise<SmokeReport>`。3つの要求（ツールなし → ツールあり → ツール結果を返して続き）を送る。ツールは TypeBox で `get_weather({ city: Type.String() })` を定義し、(c) は `Value.Check` で確かめる。(e) は本文に `<tool_call`・`</tool_call>`・`<|tool_call`・`"name":"get_weather"` などの記法がないこと。`pi` は `createGatedStreamFn(deps, { jobId: null, phase: "smoke", role })` を使う。`raw` は `runGated` に「`POST {base_url}/chat/completions` を Pi 経由と同じ `stream: true`・`stream_options: { include_usage: true }`・OpenAI 形式の `tools`（`tool_choice` は送らない）で送り、SSE を読んで本文・`tool_calls`（`index` ごとに引数をつなぐ）・`usage` を取り出す試行関数」を渡す。`raw-nostream` は同じ要求を `stream: false` で送り、JSON から取り出す（APIキーは `Authorization: Bearer`）。途中で切れた SSE は試行の失敗として返す（research R14）。1回の実行で10リクエストを超えたら止める。`detail` は `maskSecrets` と APIキーの値の置き換えを通す
- [X] T017 [US1] `src/llm/stream.ts` に `installStreamFnGuard()` を足す: `setDefaultStreamFn`（`@earendil-works/pi-agent-core`）に「`streamFn` を渡さずに呼ばれたら `Error("LLM 呼び出しは予算ゲート（createGatedStreamFn）を通すこと")` を投げる関数」を設定する。`src/llm/stream.test.ts` に、`getDefaultStreamFn()` を呼ぶと例外になるテストを足す。`src/main.ts` の起動時に呼ぶ（`src/smoke-llm.ts` からは T018 で呼ぶ）
- [X] T018 [US1] `src/smoke-llm.ts` を書く（contracts/commands.md）: 引数 `--role`（既定 `implementer`）・`--raw`・`--no-stream`（`--raw` なしならエラー）・`--compat key=value`（複数可、`true`/`false`/数値/文字列に変換、`--raw` と併用したらエラー）・`--json` を `node:util` の `parseArgs` で読む。処理は `runSmokeCli(argv, env, io): Promise<number>`（終了コードを返す）として export し、ファイルを直接実行したときだけ `process.exit(await runSmokeCli(...))` する。LLM を呼ぶ前に `SAKURA_API_KEY_ENV` を確かめ、なければ名前を示して終了コード 2。`loadConfig` → `openDatabase` → `runMigrations` → `installStreamFnGuard` → `runSmoke` → 表（contracts/commands.md の形）か JSON を出す。全部合格で 0、不合格ありで 1、実行前の失敗・予算切れ・恒久的な HTTP エラーで 2。先に `src/smoke-llm.test.ts` を書いて失敗を確かめる: APIキーがないと LLM（偽の fetch）を呼ばずに 2 を返し、標準エラーに `SAKURA_AI_API_KEY` が出る（US1-4）／`--no-stream` だけ・`--raw --compat` の組み合わせは 2／偽の LLM で全部合格なら 0、不合格ありなら 1（US1-3）。偽の fetch と DB を差し込めるよう、`runSmokeCli` の `io` にテスト用の差し替え口を持たせる
- [ ] T019 [US1] 実機でスモークテストを実行する（quickstart.md の2〜3）: さくらのAI Engine の正しい `base_url` とモデル名を確かめて `factory.toml` を直し（仮の値のコメントを消す）、`pnpm run smoke:llm`・`-- --raw`・`-- --role verifier` を実行する。不合格なら `--compat` を変えて再確認 → `--raw` と比べる（FR-026 の手順）。`--raw` も不合格なら `--raw --no-stream` で、さくらのストリーミング自体の問題かを切り分ける。トークン数が返らなければ `supportsUsageInStreaming` などを見直す。決まった互換フラグを `src/llm/provider.ts` の `DEFAULT_SAKURA_COMPAT` に、分かった `contextWindow` / `maxTokens` を定数に書く。`llm_calls` の増えた行数が表示の `requests` と一致することを `sqlite3` で確かめる
- [ ] T020 [US1] 結果を `docs/journal/YYYY-MM-DD-sakura-tool-calling.md` に書く（FR-026）: 実行したコマンド、各項目の合否（出力をそのまま）、互換フラグ、モデル名、使ったリクエスト数、気づいた挙動（`tool_choice`・本文への漏れ・usage など）、Pi を続けるか切り替えるかの判断と理由。「切り替える」なら、この時点で作業を止め、`docs/design/03`（0章・5章）と constitution の技術的制約を直す計画を立ててから続ける

**Checkpoint**: Pi を続けるか切り替えるかが決まっている（目標 2026-11-11）

---

## Phase 4: User Story 2 - すべての LLM 呼び出しを予算の範囲に収める (Priority: P1)

**Goal**: 月とジョブの上限を、再試行の前も含めて必ず守り、受付の可否を答えられる

**Independent Test**: 偽の LLM と `:memory:` の DB で、上限ちょうど手前まで `llm_calls` を入れ、次の呼び出しが通り、その次が送られない（偽の LLM の `requests` が増えない）ことを確かめる

### Tests for User Story 2

- [X] T021 [P] [US2] `src/llm/budget.test.ts` に足す: `canAcceptNewJob` が `monthly_requests − 今月の消費 >= per_job_requests` で `accept: true`、下回ると `false`、`remaining` を返す（US2-5）／月の境目: `timezone = "Asia/Tokyo"` で 2026-11-30 14:59:59.999 UTC の記録は11月、15:00 UTC 以降の呼び出しは12月として数え直される（US2-6）
- [X] T022 [P] [US2] `src/llm/stream.test.ts` に足す: 月の上限 −1 件まで記録した状態で `createGatedStreamFn` の呼び出しが1回通り、次は偽の LLM に何も送られず `error` イベント・`getBudgetExceeded(message)` が `scope: "monthly"` を返す（US2-1・US2-2、SC-002）／ジョブAが上限に達してもジョブBは通る（US2-3）／`jobId: null` はジョブの上限を見ない（US2-4）

### Implementation for User Story 2

- [X] T023 [US2] `src/llm/budget.ts` に `canAcceptNewJob(db, config, now)` を足して T021 を通す（research R12）。T022 が通らなければ `src/llm/stream.ts` の予算確認の位置を直す（試行の直前に毎回確かめる）

**Checkpoint**: SC-002（上限超えの送信 0 件）が自動テストで確かめられる

---

## Phase 5: User Story 3 - 一時的な失敗をリトライし、すべての試行を記録する (Priority: P1)

**Goal**: 一時的な失敗だけを、待ち時間を守って `max_attempts` 回まで再試行し、試行ごとに1件記録する

**Independent Test**: 偽の LLM に「429 → 成功」「500 が続く」「401」を仕込み、試行回数・記録の件数と内容・最終結果を確かめる

### Tests for User Story 3

- [X] T024 [US3] `src/llm/testing.ts` の `FakeResponse` に `{ httpError, retryAfterSeconds?, body? }`（状態コードと `retry-after` ヘッダー付きの応答）、`{ networkError }`（`fetch` が `TypeError` を投げる）、`{ midStreamError }`（SSE を数チャンク流してから本文のストリームをエラーにする）を足す
- [X] T025 [US3] `src/llm/stream.test.ts` に再試行のテストを書く（research R5・R6）: 429 → 成功で、呼び出し元は成功・記録2件（`attempt` 1 は `status = 'error'`・`error_kind = 'transient'`、2 は `ok`）（US3-1、SC-004）／500 が続くと `max_attempts`（既定3）回で失敗し3件記録（US3-2）／401・404 は1回で失敗・`error_kind = 'permanent'`（US3-3）／2回目の前に予算が尽きると送らずに予算切れ（US3-4）／途中で切れた応答の途中のテキストが外側のストリームに一切流れず、再試行して成功した応答だけが流れる（US3-5）／呼び出し元の `signal` を中止すると再試行せず `error_kind = 'aborted'` を1件記録し、`stopReason: "aborted"`（US3-6）／`retry-after: 2` なら注入した `sleep` が 2000ms 以上で呼ばれる、`retry-after` が `max_retry_delay_seconds` を超えたら再試行せず `permanent`（US3-7）／接続失敗は `transient`／`request_timeout_seconds` を超えると `timeout` で再試行する（`createTestGateDeps` の `fireTimeout()` で試行中の signal を中止して再現し、本物のタイマーは使わない。SC-006）／`x-should-retry: false` は再試行しない／記録の件数と偽の LLM の `requests` の件数が常に一致する（SC-003）。失敗を確かめる

### Implementation for User Story 3

- [X] T026 [US3] `src/llm/stream.ts` に失敗の分類 `classifyAttempt(...) => AttemptOutcome` を書く（research R6 の表どおり。200 のあとの途中のエラーは、エラー文に `terminated` / `ECONNRESET` / `socket` / `network` / `timeout` を含めば `transient`、それ以外は `permanent`）。待ち時間は `retry-after-ms` → `retry-after`（秒または日付）→ 指数バックオフ（0.5s × 2^n、上限 8s、0〜25% のジッター）
- [X] T027 [US3] `src/llm/stream.ts` の `runGated` を再試行のループにして T025 を通す（research R5・R8）: `max_attempts` まで、試行の前に毎回 `checkBudget`、試行ごとに `AbortSignal.any([呼び出し元の signal, deps.timeoutSignal(request_timeout_seconds * 1000)])` を内側に渡し、中止時は呼び出し元が中止済みなら `aborted`、そうでなければ `timeout`。待ちは `deps.sleep(ms, signal)`。最終的な失敗は `LlmCallError`（`kind`・`attempts`）。`createGatedStreamFn` は `LlmCallError` を `error` イベント（`aborted` なら `stopReason: "aborted"`）に変換する

**Checkpoint**: SC-003（記録漏れ 0）と SC-004（一時的な失敗1回で成功率 100%）が自動テストで確かめられる

---

## Phase 6: User Story 4 - LLM 呼び出しを1回ずつ計測する (Priority: P1)

**Goal**: 記録の各列が正しく入り、エラー文に秘密情報が残らず、記録できない呼び出しを作らない

**Independent Test**: 偽の LLM で成功・失敗・取り消しの呼び出しを行い、`llm_calls` の各列とマスクを確かめる

### Tests for User Story 4

- [X] T028 [P] [US4] `src/llm/stream.test.ts` に記録のテストを足す: 成功時に `input_tokens`・`output_tokens` が偽の LLM の `usage` の値、`model` が `factory.toml` のモデル名、`phase`・`role`・`job_id` が呼び出しの文脈の値（US4-1・US4-4）／失敗時に `error` が `"<状態コード> ..."` で始まり、usage がなければトークン数は NULL（US4-2）／エラー本文に APIキーの値（`"test-key-ABCDEF123"`）と `Bearer xxx` が含まれても、`error` 列と `errorMessage` には `[REDACTED]` しか残らない（US4-3、SC-005）／記録の INSERT が失敗する（DB を閉じる、または `llm_calls` を DROP する）と、LLM の応答が成功していても呼び出しは失敗になる（Edge）

### Implementation for User Story 4

- [X] T029 [US4] `src/llm/stream.ts` の記録とマスクを仕上げて T028 を通す（research R10）: エラー文は「`maskSecrets`（`src/trace/mask.ts`）→ そのとき使っている APIキーの値を `[REDACTED]` に置き換え」の順で処理してから記録・返却する。状態コードがあれば先頭に付ける。記録の失敗は `LlmCallError`（`permanent`）にして呼び出し元へ返し、ロガーに `error` で出す

**Checkpoint**: SC-005 と原則 V の記録がそろう

---

## Phase 7: User Story 5 - 偽の LLM で後続機能をテストする (Priority: P2)

**Goal**: 004・005・012 が、偽の LLM を予算ゲートの内側に差し込んでテストできる

**Independent Test**: 偽の LLM に応答を3つ仕込み、順に返ること・尽きたときのエラー・受け取った入力を確かめる

### Tests for User Story 5

- [X] T030 [P] [US5] `src/llm/testing.test.ts` を書く: テキスト・ツール呼び出し・HTTP エラーを順に仕込むと、ゲート越しに3回呼んで仕込んだ順に返る（US5-1）／尽きると `fake LLM: no more responses` を含むエラーになる（US5-2）／`requests` に `model`・`messages`・`tools` が残る（US5-3）／仕込んだ `usage` が `llm_calls` に入る（US5-4）

### Implementation for User Story 5

- [X] T031 [US5] `src/llm/testing.ts` を T030 に合わせて直し、各関数に「どのテストでどう使うか」の短いコメントを付ける。`createTestGateDeps` の設定の上書き（`budget`・`llm` の一部）を受け取れるようにする

**Checkpoint**: 後続機能が偽の LLM で予算ゲート込みのテストを書ける

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T032 [P] SC-007 の確認: `rg -n "streamSimple|completeSimple|\.stream\(|\.complete\(|chat/completions" src --glob '!**/*.test.ts'` を実行し、`src/llm/stream.ts`（ゲートの内側）と `src/llm/smoke.ts` の `raw` 試行関数（`runGated` に渡すもの）以外に LLM を呼ぶ経路がないことを確かめる。見つかったら直す
- [X] T033 [P] `specs/001-foundation/contracts/module-api.md` の末尾に「002 で追加」として `src/llm/*` を参照する1行を足し、詳細は `specs/002-llm-budget-gate/contracts/module-api.md` を正とする旨を書く
- [X] T034 `pnpm run check` を通す。ゲート・予算・偽の LLM のテストが合わせて10秒以内に終わることを `vitest run src/llm` の所要時間で確かめる（SC-006）
- [ ] T035 quickstart.md の1〜3を上から実行して、手順どおりに動くことを確かめる。食い違いがあれば quickstart.md か実装を直す
- [X] T036 実装中の試行錯誤を `docs/journal/YYYY-MM-DD-002-llm-budget-gate-実装.md` にまとめる（想定と違った挙動、エラー文、決めたこと、まだ分かっていないこと）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup（Phase 1）**: すぐ始められる
- **Foundational（Phase 2）**: Setup の後。すべてのストーリーを止める
- **US1（Phase 3）**: Foundational の後。最優先（M0 の判断）。T019・T020 は実機と APIキーが要る
- **US2（Phase 4）**: Foundational の後。US1 とは独立（`budget.ts` と `stream.test.ts` の別の箇所）
- **US3（Phase 5）**: Foundational の後。`stream.ts` を大きく変えるので、US2 の T022・T023 の後に進めると衝突しにくい
- **US4（Phase 6）**: US3 の後（記録の失敗の扱いが再試行のループに依存する）
- **US5（Phase 7）**: US3 の後（`FakeResponse` の HTTP エラー系が T024 で入る）
- **Polish（Phase 8）**: すべての後

### Within Each User Story

- テストを先に書いて失敗を確かめる → 実装 → テストが通る
- `src/llm/stream.ts` を触るタスク（T014・T017・T026・T027・T029）は同じファイルなので順に進める

### Parallel Opportunities

- T003 は T001・T002 と並行
- T008（provider のテスト）と T010（偽の fetch）は T004〜T007 と並行
- T015（US1 のテスト）は Phase 2 の後すぐ書ける
- T021・T022（US2 のテスト）は US1 の T016〜T020 と並行
- T028（US4 のテスト）と T030（US5 のテスト）は別ファイルなので並行
- T032・T033 は並行

---

## Parallel Example: Phase 2 と US1

```text
# Phase 2 で並行
T008 src/llm/provider.test.ts
T010 src/llm/testing.ts（createFakeLlm の最小）

# Phase 2 の後、US1 と US2 を並行
T015 [US1] src/llm/smoke.test.ts
T021 [US2] src/llm/budget.test.ts（canAcceptNewJob・月の境目）
```

---

## Implementation Strategy

### MVP First（US1 だけ）

1. Phase 1 → Phase 2（ゲートの最小の中核）
2. Phase 3（US1）: スモークテストを実機で回し、Pi を続けるか切り替えるかを決める
3. **止まって判断**: 切り替えるなら、設計ドキュメントを直してから `provider.ts` と `stream.ts` の内側の呼び出しを書き直す（`runGated`・`budget.ts`・記録・偽の fetch はそのまま使える）

### Incremental Delivery

1. US1 → 判断（2026-11-11 まで）
2. US2 → SC-002 を自動テストで保証
3. US3 → SC-003・SC-004
4. US4 → SC-005、原則 V の記録の完成
5. US5 → 004・005 のテストの準備
6. Polish → SC-006・SC-007、quickstart の通し確認

---

## Notes

- [P] = 別ファイルで、未完了のタスクに依存しない
- スモークテストの実機実行（T019）は1回 10 リクエスト以下。11月の残りの枠を開発中の確認に使う（実装計画 1章）
- 予算切れ・上限超過のジョブを `failed` に遷移させるのは 007。本機能はエラーを返すまで
- コミットは Phase か論理的なまとまりごとに行う
