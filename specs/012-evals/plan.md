# Implementation Plan: 回帰評価（evals）

**Branch**: `012-evals` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-evals/spec.md`

## Summary

`evals/` に作業の種類ごとのサンプル Issue（5件）と合格条件（隠しチェック）・模範解答を置き、開発機の CLI（`pnpm run eval:dev`）で全件を回す。各ケースは共有の小さなプロジェクトを一時ディレクトリに複製して git の作業ツリーにし、005 の `runPipeline`（計画から判定まで）を1回通したあと、隠しのファイルを置いて合格条件のコマンドを作業場で実行する（005 の `runChecks` を使い回す）。工程が合格し隠しチェックも通ったときだけ成功とする。判定まで進んだケースでは、主の検査役の最後の判定と同じ入力を比較用の検査役（`[models].verifier_alt`）にも1回渡し、工程名 `judge_alt` で記録する。実行ごとの結果を JSON のファイルに残し、同じセットの直前の実行と比べて差・後退・改善を表示する。評価の実行全体のリクエスト上限は、ケースごとに 1ジョブの上限を「残り」まで下げて守る。commit・push・PR・GitHub は呼ばない。

## Technical Context

**Language/Version**: TypeScript（Node.js 24 の型除去で実行、`tsc --noEmit`）

**Primary Dependencies**: 既存のみ（typebox、smol-toml、execa、drizzle-orm / better-sqlite3、pino）。新しい依存は足さない

**Storage**: 結果は JSON ファイル（`[storage].eval_dir`、既定 `data/evals`）。LLM の記録・軌跡は既存の SQLite（`llm_calls`・`agent_runs`・`jobs`）と JSONL

**Testing**: Vitest。偽の LLM（`src/llm/testing.ts`）・偽の作業場（`src/pipeline/testing.ts`）。Docker があるときだけ動く `*.docker.test.ts` で、隠しチェックの自己確認（何もしなければ落ち、模範解答で通る）を本物の作業場で確かめる

**Target Platform**: 開発機（Workshop の `dev`）。AI解禁後・12月の枠では VPS でも同じコマンドを手動で実行できる

**Project Type**: 単一プロジェクト（CLI ＋ ライブラリ）

**Performance Goals**: 偽の LLM の自動テストは各数秒以内。実機の全件1回は 250 リクエスト以内（5件 × 1ジョブあたり〜50）

**Constraints**: 評価の実行で GitHub を呼ばない。隠しのファイルを工程の入力に出さない。評価のケースは公開データだけ。自動テストで実際の LLM を呼ばない

**Scale/Scope**: ケース5件から。1回の実行でケース × 回数 ≤ 数十件

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | ✅ | 提供元が さくらの設定では `--allow-sakura` がなければ LLM を呼ぶ前に拒む（005 の CLI と同じ）。開発用の設定では公開データだけであることを表示する。ケースは本リポジトリの公開データだけ。比較用の検査役のモデル名は `factory.toml` の `verifier_alt` |
| II. 工程はコードで制御する | ✅ | 評価の流れ（複製 → 工程 → 隠しチェック → 比較用の判定 → 片付け）は決め打ち。工程の上限は 005 のものがそのまま効く。評価全体にもリクエスト上限と中断がある |
| III. 実装と検査を別モデルにする | ✅ | 比較用の検査役もツールなしの1回呼び出し（005 の `runOneShot`）で、TypeBox で検証し再要求は1回まで。`verifier_alt` が実装役と同じなら LLM を呼ぶ前に拒む |
| IV. 隔離と最小権限 | ✅ | 隠しチェックも工程内テストと同じ作業場（`--network none` 等）で実行する。APIキーを作業場に渡さない。GitHub のトークンは使わない |
| V. 予算ゲートと計測 | ✅ | すべての呼び出しは既存の予算ゲート（`completeOnce` → `createGatedStreamFn`）を通る。ケースごとに評価用のジョブを作り、`llm_calls`・`agent_runs`・軌跡に残る。比較用の判定は工程名 `judge_alt` で区別する |
| VI. 品質ゲートと自律レベルB | ✅ | 評価は判定で止め、出荷・CI・マージ・デプロイを行わない（開発ワークフローの節） |
| VII. シンプルさと差し替え可能性 | ✅ | 新しいミドルウェア・依存なし。結果はファイル、記録は既存の SQLite。005 への変更は「最後の判定の入力を結果に含める」「判定の関数に比較用の指定を足す」の2点だけ |

違反なし。Complexity Tracking は空。

**Post-design re-check（Phase 1 後）**: data-model・contracts を通して違反なし。`[storage].eval_dir` の追加は設定の項目の追加だけ（既定値ありで既存の設定ファイルはそのまま読める）。

## Project Structure

### Documentation (this feature)

```text
specs/012-evals/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── case-format.md     # evals/ のケースの形（case.toml・issue.md・setup/・hidden/・solution/）
│   ├── result-file.md     # 結果のファイル（JSON）の形と比較の規則
│   ├── commands.md        # eval:dev・eval:compare の引数・表示・終了コード
│   ├── module-api.md      # src/evals/ の入口と 005 への変更
│   └── factory-toml.md    # [storage].eval_dir・[models].verifier_alt
└── tasks.md
```

### Source Code (repository root)

```text
evals/
├── README.md                  # ケースの足し方・自己確認・実行の仕方
├── projects/
│   └── inventory/             # 共有の小さな TypeScript プロジェクト（依存なし。node --test と自前の lint）
└── cases/
    ├── test-format-price/     # 作業の種類ごとに1件
    ├── bugfix-parse-quantity/
    ├── lint-no-console/
    ├── docs-api-section/
    └── refactor-round-helper/
        ├── case.toml          # ID 以外の項目（作業の種類・対象・工程内テスト・合格条件）
        ├── issue.md           # 1行目がタイトル
        ├── setup/             # （任意）工程の前に対象へ重ねるファイル（初期状態を作る）
        ├── hidden/            # 合格条件で置く隠しのファイル（工程が終わるまで置かない）
        └── solution/          # 模範解答（自己確認で重ねる）

src/
├── evals/
│   ├── cases.ts               # ケースの読み込み・検証・ハッシュ
│   ├── prepare.ts             # 複製・重ね合わせ・git の初期化・作業場の用意（既定の実装）
│   ├── grade.ts               # 隠しのファイルを置いて合格条件を実行（runChecks を使う）
│   ├── runner.ts              # 評価の実行器（ケースの順次実行・成功の判定・比較用の判定・予算の上限・中断）
│   ├── result.ts              # 結果のファイルの型（TypeBox）・集計・書き込み・読み込み・直前の実行の検索
│   ├── compare.ts             # 2つの結果の比較・検査役ごとの集計（純粋な関数）
│   ├── format.ts              # 人が読む表示
│   ├── selfcheck.ts           # 自己確認（何もしなければ落ち、模範解答で通る。LLM を使わない）
│   └── testing.ts             # テスト用のケースと偽の prepare
├── eval-dev.ts                # pnpm run eval:dev
├── eval-compare.ts            # pnpm run eval:compare
├── pipeline/run.ts            # 変更: PipelineResult.lastJudge を足す
├── pipeline/verify.ts         # 変更: judge に比較用の検査役の指定を足す
├── pipeline/oneshot.ts        # 変更: phase に judge_alt、モデルの役割の指定を足す
└── config.ts                  # 変更: [storage].eval_dir
```

**Structure Decision**: 単一プロジェクト。評価は `src/evals/` に閉じ、005 の工程の入口（`runPipeline`）の外側に置く。GitHub 層（`src/github/`）と出荷（`ship.ts`）は import しない。

## Complexity Tracking

なし。
