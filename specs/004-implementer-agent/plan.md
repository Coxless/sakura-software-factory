# Implementation Plan: 実装役とハーネス（implementer-agent）

**Branch**: `004-implementer-agent` | **Date**: 2026-11-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-implementer-agent/spec.md`

## Summary

002（LLM層と予算ゲート）と 003（作業場・4ツール・検査・整形）を Pi の `Agent` につなぎ、実装工程を1回実行する入口を作る。中身は6つ。

1. **実装工程の組み立て**（`pipeline/implement.ts`）: Pi の `Agent` に、ゲート付きの `streamFn`・逐次実行の4ツール・`beforeToolCall`／`afterToolCall`（003 の合成関数）・`transformContext`（圧縮）・`finishTurn`（停止条件）を渡す。Pi を import するのはこのファイルだけ
2. **コンテキスト**（`harness/context.ts`・`harness/prompts/`）: 固定のシステムの指示と、AGENTS.md・Issue 文・計画・追加のフィードバックを区切って並べた最初の user メッセージ。圧縮は古いツールの結果だけを注記に置き換える純粋関数
3. **停止条件**（`harness/stop.ts`）: ターン数・期限・連続の拒否・作業場の異常を数える判定器。予算切れはゲートの結果で、中断は signal で見分ける
4. **steering**: `agent.steer()` を、終了後は受け付けない取っ手で包む
5. **軌跡**（`trace/`）: 1ジョブ1ファイルの JSONL（差分だけ。入力を復元できる）と、新しい表 `agent_runs`（実行1回の要約）。書く前にマスクする
6. **手で試すコマンド**（`implement-dev.ts`）: 開発用の LLM で、ローカルのリポジトリの複製に対して1回実行する

Pi 1.5.0 では `shouldStopAfterTurn` が廃止されて `finishTurn` になっているため、設計ドキュメントの名前を同じ変更で直す（[research.md](./research.md) R1）。

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: `@earendil-works/pi-agent-core` 1.5.0・`@earendil-works/pi-ai` 1.5.0（001 で固定済み。新しい依存は足さない）、typebox 1.4.5、better-sqlite3 ＋ Drizzle ORM、execa（`implement:dev` の git clone）

**Storage**: SQLite に `agent_runs` 表を追加（マイグレーション `0002`）。軌跡は `storage.trace_dir` の下の JSONL

**Testing**: Vitest。偽の LLM（002 の偽の `fetch`）＋本物の Pi・ゲート・アダプター＋偽の4ツール（メモリ上のファイル）で、Docker なしで実行する。作業場を使うテストは `implement.docker.test.ts` の1本だけ（Docker がなければ飛ばす）。実際の LLM は呼ばない

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービスの内部モジュール（単一プロジェクト）＋開発用のコマンド1つ

**Performance Goals**: ハーネス自体の処理（圧縮・軌跡の書き込み）は1ターンあたり数十ミリ秒以内で、LLM とツールの時間に比べて無視できること。軌跡の大きさはターン数に比例（SC-011）

**Constraints**: ツールは逐次実行。すべての LLM 呼び出しはゲートを通す。Pi の型を入口・結果に出さない（SC-010）。自動テストで実際の LLM を呼ばない。`implement:dev` で送るのは公開してよいデータだけ

**Scale/Scope**: 1工程 40 ターン程度、ツールの結果は1件 20,000 文字以下（003 の整形）。同時に動く実装工程は1つ

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | 本番は 002 のさくらのプロバイダー。`implement:dev` は開発用の設定（Google AI Studio）を前提にし、さくらの設定では `--allow-sakura` がなければ止める。送るのは公開してよいリポジトリと Issue 文だけと明記する。モデル名は `[models].implementer` | ✅ |
| II. 工程はコードで制御する | 本機能は工程の中身（実装）だけ。止まり方はターン数・期限・予算・連続の拒否で必ず決まり、終わり方として返す（遷移は 005・007）。やり直しは呼び出し側が回数を数え、毎回新しい会話で始める | ✅ |
| III. 実装と検査を別モデルにする | 実装役だけを扱う。役割 `implementer` で記録する | ✅ |
| IV. 隔離と最小権限 | ツールは 003 の作業場の中だけで動く。ループはホスト。Issue 文・AGENTS.md・CI ログ・差し込みは区切ってデータとして渡し、区切りの閉じタグを崩す。APIキーは作業場にも軌跡にも出さない | ✅ |
| V. 予算ゲートと計測 | `streamFn` は 002 の `createGatedStreamFn` だけ（`installStreamFnGuard` で素の呼び出しを塞ぐ）。軌跡を JSONL（増えた分だけ。入力を復元できる）に、実行ごとの要約とファイルの場所を SQLite（`agent_runs`）に保存し、書く前にマスクする（1.3.0 の文言）。書けなければ工程を止める | ✅ |
| VI. 品質ゲートと自律レベルB | 本機能は出荷しない。結果を 005 の工程内テスト・判定に渡す | ✅ |
| VII. シンプルさと差し替え可能性 | 新しい依存・ミドルウェアなし。ハーネスの部品（コンテキスト・停止条件・軌跡）は Pi に依存しない部品にし、Pi のフックにはつなぐだけ。Pi を import するのは `pipeline/implement.ts` だけ | ✅ |
| 技術的制約 | Pi 1.5.0（完全固定）、逐次実行、TypeBox（設定）、Vitest、pnpm | ✅ |
| 開発ワークフロー | テストで LLM を偽物に差し替える（ゲートの内側、ネットワークの手前）。ハーネスの回帰評価は 012 から（`evals/` はまだない）。`implement:dev` の結果は journal に書く | ✅ |

**Post-design re-check**（Phase 1 のあと）: data-model・contracts を見直し、違反はない。軌跡は原則 V（1.3.0）のとおり、詳細を JSONL、実行ごとの要約とファイルの場所を SQLite（`agent_runs`）に置く。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/004-implementer-agent/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── factory-toml.md   # [implementer] の追加
│   ├── module-api.md     # 005 以降に渡す関数と型
│   └── commands.md       # pnpm run implement:dev
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── drizzle/
│   └── 0002_agent_runs.sql            # agent_runs 表
├── factory.toml / factory.dev.toml    # [implementer] を追加
└── src/
    ├── config.ts                      # [implementer] のスキーマ + config.test.ts
    ├── implement-dev.ts               # pnpm run implement:dev（手動）
    ├── pipeline/
    │   ├── implement.ts               # Pi の Agent の組み立て、startImplementer / runImplementer（Pi を import する唯一のファイル）
    │   ├── implement.test.ts          # 偽の LLM ＋ 偽の4ツールで US1〜US5
    │   ├── implement.docker.test.ts   # 作業場を使う1本（Docker があるときだけ）
    │   └── testing.ts                 # 偽の Workspace、偽の LLM の応答のヘルパー
    ├── harness/
    │   ├── context.ts                 # 最初の user メッセージの組み立て、区切りの崩し、見積もり、圧縮 + context.test.ts
    │   ├── stop.ts                    # 停止条件の判定器 + stop.test.ts
    │   ├── workspace.ts               # 作業場 → Workspace（4ツール・検査・整形・AGENTS.md）
    │   └── prompts/
    │       └── implementer.ts         # 実装役のシステムの指示
    ├── queue/
    │   └── schema.ts                  # agent_runs を追加
    └── trace/
        ├── writer.ts                  # JSONL の追記とマスク + writer.test.ts
        ├── runs.ts                    # agent_runs の作成・更新 + runs.test.ts
        └── replay.ts                  # 軌跡の読み込みと入力の復元 + replay.test.ts
```

**Structure Decision**: `03` 8章の `pipeline/implement.ts`・`harness/context.ts`・`harness/prompts/`・`trace/` に置く。`harness/stop.ts` と `harness/workspace.ts` は8章にないので、8章を同じ変更で直す。`03` 8章の `harness/feedback.ts`（CI のフィードバックの整形）は 009 で作る（本機能の追加のフィードバックは `{ title, body }` の一覧を受け取るだけ）。

## 設計ドキュメントとの差分

- `03` の表「エージェント実行」と `04` 2章 層2・3章「停止条件」: `shouldStopAfterTurn` → `finishTurn`（Pi 1.5.0 で廃止。R1）。`04` 3章の停止条件に「検査の拒否が続いたとき」を足す
- `04` 3章「コンテキスト」: AGENTS.md・Issue 文・計画は最初の user メッセージに区切って置き、圧縮は古いツールの結果だけを注記に置き換えることを書く。「計測」: 軌跡は差分だけを書き、各呼び出しの入力を復元できること、SQLite には実行ごとの要約（`agent_runs`）を置くことを書く。「フィードバック（CI）」: やり直しは毎回新しい会話で始めることを書く
- `03` 8章: `harness/stop.ts`・`harness/workspace.ts`・`trace/` の中身（`writer.ts`・`runs.ts`・`replay.ts`）・`implement-dev.ts` を足す。`queue/` に `agent_runs` を足す
- `03` 5章 データ（`jobs / job_events / llm_calls / deployments / budget`）に `agent_runs` を足す
- `docs/実装計画.md` の 004 の行: `shouldStopAfterTurn` → `finishTurn`
- constitution: 原則 V の軌跡の保存を「詳細は JSONL、SQLite には実行ごとの要約とファイルの場所。入力を復元できること」に改定した（1.2.0 → 1.3.0。analyze の C1）。`shouldStopAfterTurn` の名前は憲章には書かれていない

## Complexity Tracking

違反なし。
