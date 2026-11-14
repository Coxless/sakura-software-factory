---

description: "Task list for 012 evals"
---

# Tasks: 回帰評価（evals）

**Input**: Design documents from `specs/012-evals/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。FR-033・FR-034 と SC-002〜SC-009 が自動テストでの確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。

**Organization**: ユーザーストーリーごとにまとめる。US1（セット）→ US2（実行器）は順。US3（比較）は結果の型（Phase 2）のあと US2 と並行できる。US4（検査役の比較）・US5（予算と停止）は US2 のあと。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- `src/evals/` は `src/github/`・`src/pipeline/ship*.ts`・`src/pipeline/worker.ts` を import しない（FR-009）。Pi を import しない
- LLM を使うテストは 002 の `createFakeLlm` と `createTestGateDeps`、作業場は `src/pipeline/testing.ts` の `createFakeWorkspace`・`createFakeDiffSource` を使う。実際の LLM は呼ばない
- 結果のファイル・表示に書く文字列は `maskDeep`（`src/trace/writer.ts`）でマスクする
- 想定と違う挙動・エラーに当たったら `docs/journal/2026-11-14-012-evals.md` に記録する

---

## Phase 1: Setup（設計ドキュメント・設定）

- [ ] T001 設計ドキュメントを直す（決定事項と根拠だけ）: `docs/design/04_ガードレールとハーネス設計.md` 4章に、成功の定義（工程の合格＋隠しチェック。research R1）、隠しのファイルを工程が終わるまで置かない（R3）、検査役の比較は最後の判定と同じ入力を比較用の検査役に1回渡し工程名 `judge_alt` で記録する（R5）、正解は隠しチェック（R6）、結果は1実行1ファイルで直前の実行と比べる（R8）、評価全体のリクエスト上限（R7）を足す。`docs/design/03_アーキテクチャと技術スタック.md` の 7章（検査役の比較の記録のしかた）・8章（`src/evals/`・`eval-dev.ts`・`eval-compare.ts`・`evals/` の中身）・設定の節（`[storage].eval_dir`、`[models].verifier_alt` の使い道）を直す
- [ ] T002 `src/config.test.ts` に `[storage].eval_dir` のテストを足す（省略時は `data/evals` を設定ファイルのディレクトリ基準で絶対パスにする、空文字はエラー）。`src/config.ts` の `storage` に `eval_dir: Type.String({ minLength: 1, default: "data/evals" })` を足し、`parseConfig` で `resolve(baseDir, …)` する。`factory.toml` に `eval_dir = "data/evals"`、`factory.dev.toml` に `eval_dir = "data/evals-dev"` をコメント付きで足し、`factory.toml` の `# verifier_alt = "gemma-4"` のコメントを「検査役の比較用（012 の eval:dev で使う）」に直す
- [ ] T003 [P] `package.json` に `"eval:dev": "node src/eval-dev.ts"`・`"eval:compare": "node src/eval-compare.ts"` を足す

## Phase 2: Foundational（005 への変更・結果の型）

- [ ] T004 `src/pipeline/oneshot.test.ts` に、`modelRole: "verifier_alt"`・`phase: "judge_alt"` で呼ぶと要求のモデルが `[models].verifier_alt`、`llm_calls` が `phase = "judge_alt"`・`role = "verifier"`、`agent_runs.phase = "judge_alt"` になるテストを足す。`src/pipeline/oneshot.ts` の `OneShotRequest` に `phase: "plan" | "judge" | "judge_alt"` と `modelRole?: ModelRole`（`src/llm/provider.ts`）を足し、`model = config.models[req.modelRole ?? req.role]`（`verifier_alt` が未設定なら `failed`）、`completeOnce` の `req.role` に `modelRole ?? role` を渡す
- [ ] T005 `src/pipeline/verify.test.ts` に `judge(deps, input, { alt: true })` のテスト（モデルが `verifier_alt`、`phase = "judge_alt"`、`verifier_alt` が未設定なら LLM を呼ばずに `failed`）を足し、`src/pipeline/verify.ts` に `JudgeOptions` を足す（contracts/module-api.md）
- [ ] T006 `src/pipeline/run.test.ts` に `lastJudge` のテストを足す: (1) 1回目不合格・2回目合格 → `lastJudge.round = 2`、`diff` が結果の `diff` と同じ、`checks` が検査役に渡したテスト結果の要約、(2) 判定まで進まない（テスト失敗だけ）→ `undefined`、(3) 1回目判定で不合格・2回目テスト失敗 → `lastJudge.round = 1`。`src/pipeline/run.ts` の `PipelineResult` に `lastJudge?: { round; diff; checks }` を足し、`judge` を呼ぶ直前に記録する
- [ ] T007 [P] `src/evals/result.ts` を書く（data-model.md 2〜3章、contracts/result-file.md）: TypeBox の `CaseResultSchema`・`EvalRunSchema`（`version: 1`、`status` は `succeeded` / `failed` / `error` / `not_run`、`failure` は `pipeline` / `grader` / null、`stopped` は `max_requests` / `budget_exceeded` / `aborted` / null、Judgement の `verdict` は `pass` / `fail` / `none`）と型、`summarize(cases, models)`（`executed` = succeeded＋failed、`successRate` は executed=0 なら null、`byWorkType`、`avgRequests`・`avgDurationMs` は executed の平均、`verifiers` は contracts/result-file.md「集計の規則」の検査役の集計）、`writeEvalRun(dir, run)`（`mkdirSync recursive`、`<runId>.json`、2スペースの JSON）、`readEvalRun(path)`（`Value.Check` に合わなければ例外）、`findBaseline(dir, setName, beforeStartedAt)`（壊れたファイルは `warnings` に入れて飛ばす）、`makeRunId(date, setName)`（`YYYYMMDDTHHmmssZ-<setName>`）
- [ ] T008 [P] `src/evals/result.test.ts` を書く: `summarize` の成功率（error・not_run を除く）・作業の種類ごと・平均、検査役の集計（comparable の条件、正解、falsePass・falseFail、undecided は分母に入れて不正解、トークン・応答時間の平均）、`writeEvalRun` → `readEvalRun` の往復、形の合わないファイルで `readEvalRun` が投げる、`findBaseline` が同じ setName で開始時刻が前の最新を返し、壊れたファイル・別の setName・後の時刻を飛ばす

## Phase 3: User Story 1 - 評価のセット (Priority: P1) 🎯 MVP

**Goal**: `evals/` の5件のケースを読み込み・検証でき、自己確認で合格条件の正しさを確かめられる

**Independent Test**: 正しいセットが読め、誤りがケースと理由つきで拒まれる。自己確認（Docker）で全ケースが「何もしなければ落ち、模範解答で通る」

- [ ] T009 [P] [US1] `evals/projects/inventory/` を作る（依存なし、`package.json` は `"type": "module"` だけ）: `src/price.ts`（`formatPrice(yen: number): string` — 3桁区切りと「円」、負は「-」）、`src/quantity.ts`（`parseQuantity(text: string): number` — 前後の空白を許し、正の整数だけ、ほかは例外）、`src/stock.ts`（在庫の合計・平均の計算。`Math.round(x * 100) / 100` の丸めを2か所に重複して持つ）、`src/index.ts`（再 export）、`test/*.test.ts`（`node:test` と `node:assert/strict`。`formatPrice` のテストはまだない）、`scripts/lint.ts`（`src/**/*.ts` を読み、`console.log` と `: any` を行番号つきで報告し、見つかれば終了コード 1。修正方法を表示する）、`AGENTS.md`（テストと lint のコマンド、`.eval/` に触らないこと）、`README.md`（概要だけ。API の節はまだない）。`node --test "test/**/*.test.ts"` と `node scripts/lint.ts` が通る状態にする
- [ ] T010 [P] [US1] `evals/cases/` に5件を作る（contracts/case-format.md。各 `case.toml`・`issue.md`・`hidden/.eval/*.test.ts`・`solution/`、必要なら `setup/`）: `test-format-price`（work_type `test`。Issue: `formatPrice` のテストを足す。hidden: エージェントのテストが通ること＋`formatPrice` を壊した版に差し替えるとエージェントのテストが落ちることを確かめる `.eval/mutant.test.ts`）、`bugfix-parse-quantity`（`bugfix`。setup で `parseQuantity` に「先頭の0付き（`"007"`）や空白入りで誤る」不具合を入れる。hidden: 正しい挙動のテスト）、`lint-no-console`（`chore`。setup で `src/stock.ts` に `console.log` と `: any` を入れる。check_commands は既定どおりで、初期状態で lint が落ちる。hidden: `node scripts/lint.ts` が通り、`stock` の挙動が変わらないテスト）、`docs-api-section`（`docs`。Issue: README に「## API」の節を足し、公開している関数をすべて説明する。hidden: README を読んで `## API` の見出しと `src/index.ts` が export する全関数名が節の中にあるかを確かめるテスト）、`refactor-round-helper`（`refactor`。Issue: 丸めを `src/math.ts` の `roundTo(value, digits)` に切り出して両方から使う。hidden: `roundTo` の export と挙動、`src/stock.ts` に `Math.round(` が残っていない、`stock` の挙動が変わらないテスト）。Issue 文は日本語で、受け入れ条件が読み取れる具体さにする
- [ ] T011 [P] [US1] `evals/README.md` を書く: ケースの形（contracts/case-format.md への参照）、ケースの足し方、自己確認と実行のコマンド、公開データだけで作ること、隠しのファイルを工程に見せない仕組み
- [ ] T012 [P] [US1] `src/evals/cases.test.ts` を書く（受け入れシナリオ1〜3、FR-005）: 一時ディレクトリに作ったセットで (1) 正しい2件が読める（`issue.md` の1行目がタイトル、`check_commands`・`grader` の既定、`hash` が `sha256:` で始まり内容を変えると変わる）、(2) `grader.commands` が空・`solution/` がない・`issue.md` がない・存在しない `project`・未知の項目・`work_type = "hotfix"`・ID の形の誤り、がそれぞれケース ID と理由つきの `EvalSetError`（誤りは全部集める）、(3) `only` で絞れて、存在しない ID だけなら `EvalSetError`、(4) 本物の `evals/` が読めて5件・作業の種類に test・bugfix・docs・refactor・chore を含む
- [ ] T013 [US1] `src/evals/cases.ts` を書く（contracts/module-api.md）: `cases/` の下のディレクトリを名前順に読み、`case.toml` を smol-toml で読み、TypeBox（`additionalProperties: false`、`work_type` は `src/config.ts` の `WORK_TYPES`、`grader.timeout_seconds` は 10〜1800 既定 300、`check_commands` 既定 `[]`）で検証する。`issue.md` は `src/pipeline-dev.ts` の `parseIssueFile` を使う。`hash` はケースのディレクトリとプロジェクトのファイルを相対パス順に sha256 で。`name` はセットのディレクトリ名
- [ ] T014 [P] [US1] `src/evals/prepare.ts` を書く（research R2）: `prepareCase(c, config, jobId)` — `mkdtemp` の下の `repo/` にプロジェクトを `cpSync` で複製 → `setup/` を重ねる → `git init -q`・`git add -A`・固定の作者（`-c user.name=factory-eval -c user.email=eval@invalid`）で `git commit -q -m eval-base`（フックを無効にする `-c core.hooksPath=/dev/null`）→ `install` があれば `installDependencies` → `createSandbox` → `workspaceFromSandbox`。`placeHidden()` は `hidden/` を `cpSync(force)` で上書き、`applySolution()` は `solution/` を重ねる、`close()` は作業場を片付けて一時ディレクトリを消す（どちらも失敗を握りつぶさずログ用に返す）
- [ ] T015 [P] [US1] `src/evals/grade.ts` を書く（contracts/module-api.md）: `placeHidden()` のあと、設定のコピー（`pipeline.check_commands = grader.commands`、`pipeline.check_timeout_seconds = grader.timeout_seconds`）で `runChecks` を呼び、`passed` / `failed` / `unavailable`（`skipped` はありえないが `unavailable` 扱い）にする。`placeHidden` の例外は `unavailable`
- [ ] T016 [P] [US1] `src/evals/testing.ts` を書く: テスト用のセットを一時ディレクトリに作る `writeTestSet(cases)`、偽の `PrepareCase`（`createFakeWorkspace` と `createFakeDiffSource` を使い、`placeHidden` で偽の作業場の `files` に hidden の中身を置き、`exec` の振る舞いをケースごとに決められる。`close` の呼び出しを記録する）
- [ ] T017 [US1] `src/evals/selfcheck.ts` を書く（research R11）: ケースごとに `prepare` → `runGrader` が `failed` であること → `applySolution` → `runChecks`（ケースの `check_commands`）と `runGrader` が `passed` であること、を確かめて `{ caseId, ok, problems: string[] }` を返す。`close` は必ず呼ぶ。`src/evals/selfcheck.test.ts`（偽の prepare で ok・「何もしなくても通る」・「模範解答で落ちる」を見分ける）と `src/evals/selfcheck.docker.test.ts`（`dockerSkipReason` で飛ばせる。本物の `evals/` の全ケースで ok）を書く

**Checkpoint**: `pnpm run eval:dev -- --self-check` の中身（T024 で CLI に出す）が関数として動く

## Phase 4: User Story 2 - 判定工程で止める実行器 (Priority: P1)

**Goal**: 全件を回し、ケースごとの成功・失敗と集計を結果のファイルに残す

**Independent Test**: 偽の LLM と偽の作業場で、成功・隠しチェックの失敗・工程の不合格・実行できない、を含むセットを回す

- [ ] T018 [P] [US2] `src/evals/runner.test.ts` を書く（受け入れシナリオ1〜8、SC-002・SC-003・SC-005・SC-009）: 偽の LLM の応答の列（計画 → write_file → 完了 → 合格）と偽の prepare で、(1) 工程が合格し隠しチェックが通る → `succeeded`、`requests`・`durationMs`・`pipeline.retries`、(2) 工程が合格し隠しチェックが落ちる → `failed`・`failure = "grader"`、(3) 工程が不合格（判定 fail × judge_retries+1）→ `failed`・`failure = "pipeline"`、隠しチェックの結果も記録、(4) 各ケースで `close` が呼ばれ、次のケースは新しい prepare、(5) 偽の LLM が受け取ったすべての要求の本文に、隠しのファイルの内容（固有の文字列）が現れない、(6) prepare が投げる → `error` で次のケースへ進む、(7) ケースの `check_commands` が工程内テストのコマンドとして作業場で実行される、(8) `jobs` に `repo = "eval:<set>/<case>"` の行ができ、`llm_calls` の件数と `requests` が一致する、(9) `ghp_…` を含む隠しチェックのログが結果で `[REDACTED]`、(9b) 実装役が隠しのファイルと同じパス（`.eval/…`）に書いたファイルが、隠しチェックの時点では隠しのファイルの内容に上書きされている、(9c) 工程が `aborted` なら隠しチェックを実行しない、(10) `src/evals/` のどのファイルも `github/`・`ship` を import していない（ソースを読んで確かめる）
- [ ] T019 [US2] `src/evals/runner.ts` を書く（contracts/module-api.md、data-model.md 2章の状態の決まり方）: ケース × 回ごとに `jobs` に1行 → 設定のコピー（`pipeline.check_commands = c.checkCommands`）→ `prepare` → `runPipeline`（`deadline = now + timeoutMinutes`、`signal`、`onPhase` を `onProgress` へ）→ `runGrader` → 状態の決定 → `close`。`requests` は `countLlmCallsForJob`、`durationMs` は工程の開始から隠しチェックの終了まで。主の検査役の Judgement は `result.verdict` と `llm_calls`（phase `judge`）の集計から作り、`comparable` は research R6（`lastJudge.diff === result.diff` かつ隠しチェックが passed/failed）。例外は投げず、最後に `summarize` して `EvalRun` を返す（`harness`・`provider`・`models`・`options` を含む）
- [ ] T020 [P] [US2] `src/evals/format.ts` を書く: `formatRun(run, comparison?)`（contracts/commands.md の表示。時間は `4m10s` の形、率は小数1桁の %）・`formatComparison`・`formatEstimate({ cases, repeat, maxRequests, perJob })`。`src/evals/format.test.ts` で主な行（cases・summary・verifiers・vs）が出ることを確かめる
- [ ] T021 [P] [US2] `src/eval-dev.test.ts` を書く（contracts/commands.md）: (1) 引数の解析（`--repeat`・`--max-requests`・`--timeout-minutes` は1以上の整数、`--cases` はカンマ区切り、未知の引数はエラー）、(2) さくらの設定で `--allow-sakura` なし → 2、LLM を呼ばない、(3) 開発用の設定で公開データだけの表示、(4) APIキーがない → 2、(5) セットの誤り → 2、(6) `verifier_alt` が `implementer` と同じ → 2、(7) 全件を実行 → 0、結果のファイルが `eval_dir` にでき、表示に `result:` の行、(8) `--json` で `summary` を含む JSON、(9) `--self-check` は APIキーなしで動き、全部 ok → 0、ok でないケースがある → 1、(10) 見積もりの行が標準エラーに出る
- [ ] T022 [US2] `src/eval-dev.ts` を書く: `src/pipeline-dev.ts` の作り（`parseArgs`、`io` の差し替え口、`--allow-sakura`、`PUBLIC_DATA_NOTICE`、`defaultDeps`、`installStreamFnGuard`、SIGINT → `AbortController`）に合わせ、`loadEvalSet` → 見積もり → `runEvals` → `writeEvalRun` → `findBaseline`（`--baseline` があればそれ）→ `compareRuns` → 表示。`harness` は `git rev-parse HEAD` と `git status --porcelain`（失敗したら `unknown`）。`--self-check` は設定だけを読み、`selfCheck` を呼ぶ

## Phase 5: User Story 3 - 前回の評価と比べる (Priority: P1)

**Goal**: 2つの結果から差・後退・改善・設定の違いを出す

**Independent Test**: 結果のファイル2つで `compareRuns` と `eval:compare` を確かめる

- [ ] T023 [P] [US3] `src/evals/compare.test.ts` を書く（受け入れシナリオ1〜7、SC-008）: (1) 共通の集合での成功率・平均リクエスト数・平均処理時間の before / after / delta、(2) succeeded → failed/error が `regressions`、(3) failed/error → succeeded が `improvements`、(4) 片方にしかない・not_run が `onlyInBaseline` / `onlyInCurrent` に入り、集計から外れる、(5) `caseHash` が違うケースが `changedCases`、(6) models・provider・harness.commit の違いが `configDiff`、(7) 共通が0件でも例外にならず metrics が null
- [ ] T024 [US3] `src/evals/compare.ts` を書く（data-model.md 4章、contracts/result-file.md「比較の規則」）
- [ ] T025 [US3] `src/eval-compare.ts` と `src/eval-compare.test.ts` を書く: 引数は2つのパスと `--json`。読めない・形が合わない → 2（メッセージにパス）、表示 → 0。LLM・DB・設定を使わない

## Phase 6: User Story 4 - 検査役のモデルを比べる (Priority: P2)

**Goal**: 判定まで進んだケースで、比較用の検査役にも同じ入力で判定させて並べる

**Independent Test**: 偽の LLM で主と比較用に違う判定を返させる

- [ ] T026 [US4] `src/evals/runner.test.ts` に検査役の比較のテストを足す（受け入れシナリオ1〜8、SC-006）: (1) `verifier_alt` を設定すると、判定まで進んだケースで比較用の呼び出しが1回（モデルが `verifier_alt`、`phase = "judge_alt"`）、要求の本文の diff が主の最後の判定と同じ、(2) 主 pass・比較用 fail・隠しチェック passed → 主が正解・比較用が falseFail、(3) 比較用の判定でケースの状態が変わらない、(4) 判定まで進まないケースでは呼ばない、(5) 比較用が2回とも形に合わない → `verdict: "none"`・`undecided`、ほかのケースは続く、(6) `verifier_alt` 未設定なら比較用の呼び出し0件、(7) 比較用の呼び出しは判定まで進んだ1ケースあたり2回を超えない
- [ ] T027 [US4] `src/evals/runner.ts` に比較用の判定を足す: `config.models.verifier_alt` があり `result.lastJudge` があれば、隠しチェックのあと（作業場が要らないので片付けの前後どちらでもよい）、`judge({ gate, now }, { jobId, issue, instruction, planText: result.planText, diff: lastJudge.diff, checks: lastJudge.checks, signal }, { alt: true })` を呼び、`verifierAlt` の Judgement（`llm_calls` の phase `judge_alt` の集計）を作る。`budget_exceeded` なら評価を止める（US5 の規則）。`eval-dev.ts` の開始前の検査で `verifier_alt === implementer` を拒む（T021 (6)）

## Phase 7: User Story 5 - 予算の中で評価を回す (Priority: P2)

**Goal**: 評価全体の上限・月の予算切れ・中断で止まり、残りを未実行にして結果を残す

**Independent Test**: 偽の LLM で上限を小さくする・予算ゲートで止める・中断する

- [ ] T028 [US5] `src/evals/runner.test.ts` に予算と停止のテストを足す（受け入れシナリオ2〜5、SC-007）: (1) `maxRequests` を2ケース目の途中で尽きる値にすると、2ケース目は工程が `budget_exceeded`、3ケース目以降は `not_run`、`stopped = "max_requests"`、全体の `llm_calls` 件数が `maxRequests` 以下、(2) 月の予算（`monthly_requests` を小さく）で止まる → `stopped = "budget_exceeded"`、残りが `not_run`、(3) 1ケースが1ジョブの上限（`per_job_requests`）で止まり、評価全体の上限には余裕がある → そのケースだけ `failed` で次へ進む、(4) 実行中に `signal` を中止 → `stopped = "aborted"`、実行中のケースの `close` が呼ばれ、残りが `not_run`、(5) `not_run` は `summarize` の executed に入らない、(6) 月の残りがケースの1ジョブの上限を下回っている（`monthly_requests` の残りを `per_job_requests` 未満にしておく）→ そのケースを始める前に LLM を呼ばずに `stopped = "budget_exceeded"`、全ケースが `not_run`（FR-032a）
- [ ] T029 [US5] `src/evals/runner.ts` に予算と停止を足す（research R7）: ケースの前に `used`（評価で作ったジョブの `llm_calls` の合計）を数え、`maxRequests - used <= 0` なら残りを `not_run`・`stopped = "max_requests"`。設定のコピーで `budget.per_job_requests = min(per_job_requests, maxRequests - used)`。そのコピーで `canAcceptNewJob`（`src/llm/budget.ts`）を呼び、受け付けられなければ LLM を呼ばずに残りを `not_run`・`stopped = "budget_exceeded"`（FR-032a）。工程か比較用の判定が `budget_exceeded` で、そのジョブの消費が下げた1ジョブの上限に達していなければ月の予算切れとして `stopped = "budget_exceeded"`、達していて評価全体の残りが0なら `max_requests`。`signal` の中止で `stopped = "aborted"`。`eval-dev.ts` は `stopped` があれば終了コード 3

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T030 [P] `rg -n "github/|ship" src/evals src/eval-dev.ts src/eval-compare.ts` で GitHub 層と出荷を import していないこと、`rg -n "pi-agent-core|pi-ai" src/evals` で Pi を import していないことを確かめる
- [ ] T031 `workshop exec dev -- bash -lc 'cd /project && pnpm run check && pnpm run secrets:scan'` を通す（テスト用の偽の秘密情報は `.gitleaks.toml` で1件ずつ許可）。Docker があれば `pnpm run sandbox:build` のあと `pnpm run eval:dev -- --self-check` を流し、結果を journal に書く
- [ ] T032 `docs/design/`・`docs/実装計画.md`・`specs/012-evals/` を見直し、実装で変わった決定（値・名前・コマンド）があれば同じ変更で直す。`docs/journal/2026-11-14-012-evals.md` に、選択肢を比べて決めたこと（research の R1・R2・R5・R7）と実装で分かったことを書く

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1**: 依存なし
- **Phase 2**: T002 のあと（T007 は設定に依存しないのでいつでも）。T004 → T005 → T006 の順（同じ流れのファイル）
- **US1（Phase 3）**: T009・T010・T011・T012・T014・T015・T016 は並行できる。T013 は T012 のあと、T017 は T013〜T016 のあと
- **US2（Phase 4）**: US1 と Phase 2 のあと
- **US3（Phase 5）**: T007 のあと。US2 と並行できる（T022 が `compareRuns` を使うので、T022 の前に T024）
- **US4・US5**: US2 のあと。どちらも `runner.ts` を触るので順に（US4 → US5）
- **Polish**: すべてのあと

### Parallel Opportunities

- Phase 3 の `evals/` の中身（T009〜T011）と `src/evals/` の部品（T012・T014〜T016）
- US3（compare）と US2（runner・CLI）

## Parallel Example: US1

```text
Task: "T009 evals/projects/inventory"     Task: "T010 evals/cases の5件"
Task: "T012 cases.test.ts"                Task: "T014 prepare.ts"
Task: "T015 grade.ts"                     Task: "T016 testing.ts"
```

## Implementation Strategy

### MVP First

1. Phase 1・2
2. US1（セット・自己確認）で、合格条件が正しいことを確かめる（**止めて確かめる**）
3. US2（実行器・CLI）と US3（比較）で「回して前回と比べる」が成り立つ
4. US4（検査役の比較）・US5（予算と停止）を足す

### 実装計画との関係

- M3（11/25〜12/02）で偽の LLM で作る。開発用の LLM（Google AI Studio）で1件だけ手で回すのは任意
- 実機の評価と検査役の比較は12月の枠（M4）。`factory.toml` の `verifier_alt` を有効にしてから回す
