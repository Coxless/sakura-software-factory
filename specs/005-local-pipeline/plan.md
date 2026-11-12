# Implementation Plan: 計画・工程内テスト・判定（local-pipeline）

**Branch**: `005-local-pipeline` | **Date**: 2026-11-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-local-pipeline/spec.md`

## Summary

004 の実装工程の前後に、計画役（ツールなしの1回呼び出し）・工程内テスト（決め打ちのコマンド）・検査役（ツールなしの1回呼び出し＋JSON の検証）をつなぎ、不合格ならやり直す工程を決め打ちで書く。中身は7つ。

1. **1回呼び出し**（`llm/complete.ts`）: 002 のゲート付き `streamFn` を `tools` なしで1回呼ぶ。Pi の型は `llm/` の中に閉じる（research R1）
2. **構造化出力**（`harness/structured.ts`）: JSON の取り出し・TypeBox の検証・再要求の文（R2）
3. **計画役**（`pipeline/plan.ts`・`harness/prompts/planner.ts`）: Issue・依頼・AGENTS.md・ファイル一覧から `{ summary, steps, acceptance_criteria, work_type }`（R3・R10）
4. **工程内テスト**（`pipeline/checks.ts`）: `[pipeline].check_commands` を作業場で順に実行。004 に `onComplete` の口を足し、実装役が完了を告げた時点で走らせ、失敗を同じ会話に差し込む（R4・R5）
5. **検査役**（`pipeline/verify.ts`・`harness/prompts/verifier.ts`）: Issue・計画・diff・テスト結果から `{ verdict, reasons, criteria, fixes }`（R10・R11）
6. **工程の流れ**（`pipeline/run.ts`・`pipeline/diff.ts`）: 計画 → (実装 ⇄ テスト) → 判定 → やり直し、の決め打ちのループと終わり方。diff はホストで一時インデックスから取る（R6・R7）
7. **CLI**（`pipeline-dev.ts`）: `implement:dev` を置き換える `pnpm run pipeline:dev`（R12）

記録は 004 の軌跡と `agent_runs` を使い回し、判定の合否の列 `verdict` だけを足す（R9）。状態機械に `testing → implementing` を足す（R8）。

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: `@earendil-works/pi-agent-core` 1.5.0・`@earendil-works/pi-ai` 1.5.0（固定済み）、typebox 1.4.5、better-sqlite3 ＋ Drizzle ORM、execa（git）。新しい依存は足さない

**Storage**: SQLite の `agent_runs` に `verdict` 列を追加（マイグレーション `0003`）。軌跡は 004 の JSONL に行の種類を足す

**Testing**: Vitest。偽の LLM（002 の偽の `fetch`）＋本物の Pi・ゲート・アダプター＋偽の作業場（004 の `createFakeWorkspace` に `exec` を足す）＋偽の diff。`diff.test.ts` は一時ディレクトリの本物の git を使う。作業場を使うテストは `run.docker.test.ts` の1本だけ（Docker がなければ飛ばす）。実際の LLM は呼ばない

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービスの内部モジュール（単一プロジェクト）＋開発用のコマンド1つ

**Performance Goals**: 工程の制御・検証・diff の取り出しは、LLM とテストのコマンドの時間に比べて無視できる（1回あたり1秒以内）。1ジョブのリクエスト数は「計画 1〜2 ＋ 実装（ターン数）×回数 ＋ 判定 1〜2 ×回数」で、予算ゲートのジョブの上限で必ず止まる

**Constraints**: 計画役・検査役に `tools` を渡さない。再要求は1回まで。テストに通らない変更で検査役を呼ばない。すべての反復と期限に上限。工程内テストのコマンドは設定からだけ読む。自動テストで実際の LLM を呼ばない。`pipeline:dev` で送るのは公開してよいデータだけ

**Scale/Scope**: 同時に動く工程は1つ。diff は 40,000 文字、ログは 8,000 文字、ファイル一覧は 10,000 文字で切り詰める（仮の値）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | 本番は 002 のさくらのプロバイダー。モデル名は `[models].planner`・`verifier`。`pipeline:dev` は さくらの設定では `--allow-sakura` がなければ止め、開発用の設定では「公開してよいデータだけ」を表示する | ✅ |
| II. 工程はコードで制御する | 計画 → 実装 ⇄ テスト → 判定 → やり直しを `run.ts` に決め打ちで書く。LLM の出力は合否の値としてだけ使い、工程の順番を変えさせない。やり直し（`judge_retries`）・テストの差し込み（`max_check_feedbacks`）・ターン数・期限・予算のすべてに上限。失敗時の報告は 007 が行う（本機能は理由を返す） | ✅ |
| III. 実装と検査を別モデルにする | 計画役・検査役は `llm/complete.ts` で `tools` を渡さずに1回呼ぶ。検査役の出力はプロンプトで JSON を出させ、TypeBox で検証、再要求は1回まで。`verifier` と `implementer` が同じ名前なら工程を始めない | ✅ |
| IV. 隔離と最小権限 | テストのコマンドは作業場（ネットワークなし）の中だけで走る。diff・ファイル一覧の取り出しはホストの git（読むだけ。一時インデックスでインデックスを変えない）。Issue・依頼・AGENTS.md・ファイル一覧・diff・ログは区切ってデータとして渡し、閉じタグを崩す。コマンドはリポジトリのファイルから読まない | ✅ |
| V. 予算ゲートと計測 | 計画役・検査役の呼び出しも `createGatedStreamFn` だけを通す（再要求も1件）。工程（`plan`・`judge`）と役割を付けて `llm_calls` に記録。軌跡は JSONL（入力を復元できる `llm_request`）、要約は `agent_runs`（`verdict` 列を追加）。書く前にマスクし、書けなければ止める | ✅ |
| VI. 品質ゲートと自律レベルB | 工程内テストは決まったコマンド（既定は CI と同じ `pnpm run check`）。テストに通らない変更は判定に進めず、合格にもしない。出荷・自動マージは 008（本機能は `work_type` と diff を渡すだけ） | ✅ |
| VII. シンプルさと差し替え可能性 | 新しい依存・ミドルウェア・表なし（列を1つ足すだけ）。Pi を import するのは `pipeline/implement.ts` と `llm/` だけ。工程の部品（計画・テスト・判定・diff）は関数で分け、`run.ts` は組み立てだけ。GitHub に触れない | ✅ |
| 技術的制約 | TypeBox（計画・判定・設定）、Vitest、pnpm、execa | ✅ |
| 開発ワークフロー | テストで LLM を偽物に差し替える。ハーネスの回帰評価は 012 から（`evals/` はまだない）。`pipeline:dev` の結果は journal に書く。設計と食い違う点（状態機械・ディレクトリ構成）は同じ変更で設計ドキュメントを直す | ✅ |

**Post-design re-check**（Phase 1 のあと）: data-model・contracts を見直し、違反はない。`agent_runs` を1回呼び出しにも使うのは原則 V の「工程の実行1回ごとの要約」に合う。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/005-local-pipeline/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── factory-toml.md   # [pipeline] の追加
│   ├── module-api.md     # 007・008・012 に渡す関数と型、004 への追加
│   └── commands.md       # pnpm run pipeline:dev
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── drizzle/
│   └── 0003_agent_runs_verdict.sql    # agent_runs.verdict
├── factory.toml / factory.dev.toml    # [pipeline] を追加
├── package.json                       # pipeline:dev を足し、implement:dev を消す
└── src/
    ├── config.ts                      # [pipeline] のスキーマ、allowed_work_types の検証 + config.test.ts
    ├── pipeline-dev.ts                # pnpm run pipeline:dev（implement-dev.ts を置き換え） + pipeline-dev.test.ts
    ├── llm/
    │   └── complete.ts                # ツールなしの1回呼び出し + complete.test.ts
    ├── harness/
    │   ├── structured.ts              # JSON の取り出し・検証・再要求の文 + structured.test.ts
    │   ├── context.ts                 # DATA_TAGS に instruction・files・diff・checks を足す
    │   ├── workspace.ts               # Workspace.exec を足す
    │   └── prompts/
    │       ├── blocks.ts              # 計画役・検査役の入力のデータの区切り（切り詰めと閉じタグの崩し）
    │       ├── planner.ts             # 計画役のシステムの指示と入力の組み立て
    │       └── verifier.ts            # 検査役のシステムの指示と入力の組み立て
    ├── pipeline/
    │   ├── run.ts                     # runPipeline / runPipelineInSandbox（工程の流れ） + run.test.ts・run.docker.test.ts
    │   ├── plan.ts                    # 計画役、PlanSchema、WORK_TYPES、planToText + plan.test.ts
    │   ├── checks.ts                  # 工程内テスト + checks.test.ts
    │   ├── verify.ts                  # 検査役、VerdictSchema + verify.test.ts
    │   ├── oneshot.ts                 # 計画役・検査役で共通の「1回呼び出し＋検証＋再要求1回＋記録」
    │   ├── diff.ts                    # git の diff の取り出し + diff.test.ts
    │   ├── implement.ts               # onComplete の口、completionChecks
    │   └── testing.ts                 # 偽の作業場に exec、偽の DiffSource
    ├── queue/
    │   └── schema.ts                  # agent_runs.verdict
    └── trace/
        ├── writer.ts                  # 行の種類を足す
        ├── runs.ts                    # verdict を書く
        └── replay.ts                  # replayCompletion
```

**Structure Decision**: `03` 8章の `pipeline/plan.ts`・`verify.ts`・`state.ts` のうち、`state.ts`（状態機械）は 007 で作る（本機能は `onPhase` で境目を知らせるだけ）。8章にない `pipeline/run.ts`・`checks.ts`・`oneshot.ts`・`diff.ts`、`llm/complete.ts`、`harness/structured.ts`、`pipeline-dev.ts` を足し、`implement-dev.ts` を消すので、8章を同じ変更で直す。

## 設計ドキュメントとの差分

同じ変更で直す（tasks の最初のフェーズに入れる）。

- `03` 3章（状態機械）: `testing ──(工程内テストの失敗)──▶ implementing（上限あり）` を足す（R8）
- `03` 4章 #3（計画）: 出力は JSON（概要・作業手順・受け入れ条件・作業の種類）で、TypeBox で検証し再要求は1回まで。#5（テスト）: コマンドは `factory.toml` の `[pipeline].check_commands`（対象リポジトリのファイルからは読まない）、実装役が完了を告げた時点で実行、失敗の差し込みは上限あり、上限を超えたら判定せずに不合格。#6（判定）: diff が空・テスト失敗なら検査役を呼ばない。不合格のやり直しは作業ディレクトリを戻さず新しい会話で、理由と今の diff を渡す。検査役の出力が2回とも合わなければ失敗
- `03` 5章「設定」: `factory.toml` の項目に「工程内テストのコマンド」を足す
- `03` 8章: 上の Structure Decision のとおり。`implement-dev.ts` → `pipeline-dev.ts`
- `04` 3章「フィードバック（工程内）」: 実装役が完了を告げたときに決まったコマンドを走らせ、失敗を steering で差し込む（上限あり）ことを書く
- `docs/実装計画.md` 1章「AI解禁の日の流れ」: 「005 の CLI」を `pnpm run pipeline:dev` と書く
- constitution: 変更なし（原則 III・V・VI の範囲の中）

## Complexity Tracking

違反なし。
