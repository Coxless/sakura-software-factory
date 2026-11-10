# Implementation Plan: 基盤（foundation）

**Branch**: `001-foundation` | **Date**: 2026-11-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-foundation/spec.md`

## Summary

後続の機能（002〜012）が乗る土台を作る。内容は4つ。

1. **品質チェック**: `pnpm run check`（Biome → tsc → Vitest）をローカルと CI で同じに使う
2. **設定**: `factory.toml` を TypeBox 1.x で検証し、型付きで凍結した設定として渡す
3. **記録**: better-sqlite3（WAL）と Drizzle で5テーブルを作る。起動時と専用コマンドのどちらでもマイグレーションを適用できる
4. **ログ**: pino の JSON ログ。秘密情報は項目名と値の両方で伏せる

TypeScript はビルドせず、Node 24 の型除去でそのまま実行する。001 の起動処理は「設定 → ログ → マイグレーション」で終わる。常駐（HTTP と Worker）は 006・007 で足す。

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: typebox 1.4.5、smol-toml 1.9.1、pino 10.4.0、better-sqlite3 13.0.3、drizzle-orm 0.45.4（dev: drizzle-kit 0.31.11、@biomejs/biome 2.6.6、vitest 5.1.0）。すべて完全に固定する（[research.md](./research.md) R1）

**Storage**: SQLite 1ファイル（既定 `data/factory.db`、WAL）。マイグレーションは `drizzle/` に SQL で置く

**Testing**: Vitest。DB は `:memory:` か一時ファイル。外部サービスには接続しない

**Target Platform**: Linux（開発は Ubuntu Workshop `dev`、本番は さくらのVPS）

**Project Type**: 常駐サービス（CLI のエントリーポイントを持つ単一プロジェクト）

**Performance Goals**: `pnpm run check` が2分以内（SC-001）。LLM 呼び出し1,000件で月とジョブの集計が1秒以内（SC-005）

**Constraints**: 1台・1プロセス。ビルド手順なし（`erasableSyntaxOnly`）。pnpm 以外のパッケージマネージャーは使わない

**Scale/Scope**: 月3,000件の LLM 呼び出し、数十〜数百件のジョブ。5テーブル

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | モデル名・エンドポイントを `factory.toml` に置き、既定値を持たせない。退避先 `fallback` も設定で持つ | ✅ |
| II. 工程はコードで制御する | 状態の値を `03` 3章の12個に限る（CHECK 制約）。反復とタイムアウトの上限を設定項目として用意する | ✅ |
| III. 実装と検査を別モデルにする | `implementer` と `verifier` を別の設定項目にする（別系統かどうかの確認は 002 で行う） | ✅ |
| IV. 隔離と最小権限 | 秘密情報は設定ファイルに書かせず（未知の項目エラー＋案内）、環境変数からだけ読む。ログで伏せる。サンドボックスは 003 の範囲 | ✅ |
| V. 予算ゲートと計測 | `llm_calls` に原則 V の列をすべて持たせる。月（タイムゾーン付き）とジョブごとの件数の集計を用意する。`maskSecrets` を 004 の軌跡でも使える場所に置く | ✅ |
| VI. 品質ゲートと自律レベルB | `pnpm run check` を CI と同じにする。自動マージ条件（diff 上限・禁止パス・作業の種類）を設定項目として用意する | ✅ |
| VII. シンプルさと差し替え可能性 | SQLite 1つ。新しいミドルウェアなし。ビルド手順なし。タイムゾーン計算は `Intl` で済ませ、依存を増やさない | ✅ |
| 技術的制約 | Node 24・pnpm（corepack）・TypeBox（Zod なし）・better-sqlite3＋Drizzle・smol-toml・pino・Biome・Vitest | ✅ |
| 開発ワークフロー | Workshop `dev` で実行。テストで LLM を呼ばない | ✅ |

**Post-design re-check**（Phase 1 のあと）: data-model・contracts を見直し、違反はない。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/001-foundation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── factory-toml.md   # 設定ファイルの形と検証エラー
│   ├── commands.md       # pnpm scripts
│   └── module-api.md     # 後続機能に渡す関数と型
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

リポジトリのルートを `03` 8章の `factory/` に当てる。001 で作るのは次のとおり（後続の機能のディレクトリは、その機能で作る）。

```text
.
├── package.json             # packageManager: pnpm@12.18.0、scripts は contracts/commands.md
├── pnpm-lock.yaml
├── pnpm-workspace.yaml      # ビルドを許可する依存（better-sqlite3, esbuild）、save-exact
├── tsconfig.json            # 型チェック専用（research R2）
├── biome.json
├── vitest.config.ts
├── drizzle.config.ts
├── factory.toml             # 動く設定（秘密情報なし）。テストで検証が通ることを確かめる
├── .gitignore               # node_modules, data/
├── .github/workflows/ci.yml # setup-node（Node 24）→ corepack → pnpm install --frozen-lockfile → pnpm run sandbox:build → pnpm run check
├── drizzle/                 # 生成した SQL マイグレーション
└── src/
    ├── main.ts              # 起動: loadConfig → createLogger → openDatabase → runMigrations
    ├── migrate.ts           # pnpm run db:migrate
    ├── config.ts            # + config.test.ts
    ├── log.ts               # + log.test.ts
    ├── trace/
    │   └── mask.ts          # + mask.test.ts
    └── queue/
        ├── schema.ts        # 5テーブルと列挙値
        ├── db.ts            # openDatabase, runMigrations  + db.test.ts
        ├── jobs.ts          # claimNextQueuedJob           + jobs.test.ts
        ├── llm-calls.ts     # 月・ジョブの件数              + llm-calls.test.ts
        └── month.ts         # monthRange                   + month.test.ts
```

**Structure Decision**: 単一プロジェクト。`03` 8章の層（`config.ts`、`log.ts`、`migrate.ts`、`queue/`、`trace/`）に合わせて置き、テストは対象ファイルの隣に置く（research R10）。LLM 呼び出しの件数の集計は `queue/llm-calls.ts` が持ち、それを使って可否を判断するのは 002 の `llm/budget.ts` とする。

## 設計ドキュメントとの差分

- `03` 5章の Pi のバージョンの記述（1.x）と、TypeBox のパッケージ名（`typebox` 1.x）を本計画に合わせて直した
- `03` 8章のディレクトリ構成に、`migrate.ts`・`log.ts`・`queue/` の各ファイル・`trace/mask.ts`・`.github/workflows/ci.yml` を足し、集計（`queue/llm-calls.ts`）と判断（`llm/budget.ts`）の分担を書いた
- それ以外に、`docs/design/` を直す必要のある決定はない

## Complexity Tracking

違反なし。
