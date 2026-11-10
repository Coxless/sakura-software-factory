# Implementation Plan: サンドボックスと4ツール（sandbox-tools）

**Branch**: `003-sandbox-tools` | **Date**: 2026-11-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-sandbox-tools/spec.md`

## Summary

実装役（004）の手足と、ガードレールの層3〜5を作る。内容は5つ。

1. **作業場のイメージ**: `sandbox/Dockerfile`（`node:24-slim` ＋ git・ripgrep・pnpm）
2. **作業場（層5）**: ジョブ専用コンテナを隔離フラグ一式で起動し、`docker exec` で実行し、必ず片付ける。`.git` は読み取り専用で重ねてマウントする。依存のインストールだけ、ネットワークありの一時コンテナで行う
3. **4ツール**: `read_file` / `write_file` / `edit_file` / `bash`。Pi の `AgentTool` と同じ形で、中身は `docker exec`
4. **検査（層3）**: パスの検査（名前の上と、作業場の中で解決した実際のパスの両方）、禁止パス、危険なコマンドの形。合成関数で順に実行し、最初の拒否で止める
5. **整形（層4）**: 長い出力の切り詰め（先頭と末尾を残す）と秘密情報のマスク。合成関数で順に適用する

Pi には依存しない。型の形を Pi 1.5.1 に合わせ、004 で `beforeToolCall` / `afterToolCall` / `tools` にそのまま渡す（[research.md](./research.md) R7）。

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: 001 の依存に加えて execa 10.2.1（完全固定）。Docker（CLI とデーモン）。ツールの引数のスキーマは typebox 1.4.5

**Storage**: なし（作業ディレクトリはホストのディスク。記録は 004 の軌跡）

**Testing**: Vitest。検査・整形・合成・引数の検証は Docker なしで実行する。作業場を使うテスト（`*.docker.test.ts`）は Docker とテスト用イメージがあるときだけ実行し、なければ理由を出して飛ばす（R12）

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービスの内部モジュール（単一プロジェクト）

**Performance Goals**: 作業場の用意が10秒以内（SC-005）、ツール1回が1秒以内（SC-004。`docker exec` 1回は実測約 80ms）

**Constraints**: ツールは逐次実行（FR-017）。作業場に秘密情報を渡さない。root で作業場を動かさない

**Scale/Scope**: 同時に動く作業場は1つ（LLM を使う工程の同時実行は1件。原則 VII）。ファイル数千・`node_modules` 込みの TypeScript リポジトリ

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | LLM を呼ばない | ✅ |
| II. 工程はコードで制御する | `bash` に時間の上限、依存のインストールに時間の上限。工程の遷移は扱わない | ✅ |
| III. 実装と検査を別モデルにする | 扱わない（ツールは実装役だけが使う） | ✅ |
| IV. 隔離と最小権限 | `--network none`・`--read-only`・`--cap-drop ALL`・`no-new-privileges`・非root・CPU/メモリ/プロセス数の制限・`bash` のタイムアウト。環境変数は `HOME` だけ。読み書きは作業ディレクトリ内に限り、`.github/workflows`・`.env`・ロックファイル・デプロイ設定・`.git` の書き込みを拒否。さらに `.git` を読み取り専用でマウントし、ホストの commit でコードが動く経路を塞ぐ（R3） | ✅ |
| V. 予算ゲートと計測 | LLM を呼ばない。ツールの結果に記録用の詳細（終了コード・所要時間・打ち切りの有無）を持たせ、004 の軌跡で使う。秘密情報のマスクは 001 の `maskSecrets` を使う | ✅ |
| VI. 品質ゲートと自律レベルB | `bash` のガードはやわらかい層とし、禁止パスの変更は 008 の層6で検出する前提を明記する | ✅ |
| VII. シンプルさと差し替え可能性 | 新しいミドルウェアなし。依存は execa だけ（constitution の主要ライブラリ）。glob は Node の `path.matchesGlob`。検査と整形は部品にして合成関数で積む | ✅ |
| 技術的制約 | Node 24・pnpm・TypeBox・execa・Vitest。Pi は 004 で入れる（本機能は依存しない） | ✅ |
| 開発ワークフロー | Workshop `dev` で実行。テストで LLM を呼ばない。ツール・ガードを変えたら 012 以降は回帰評価（本機能の時点では `evals/` がない） | ✅ |

**Post-design re-check**（Phase 1 のあと）: data-model・contracts を見直し、違反はない。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/003-sandbox-tools/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── factory-toml.md   # [sandbox] と [tools] の追加分
│   ├── tools.md          # 4ツールの引数・結果・エラーの文面
│   ├── module-api.md     # 004 以降に渡す関数と型
│   └── commands.md       # 追加する pnpm scripts
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── sandbox/
│   └── Dockerfile                 # node:24-slim + git・ripgrep・pnpm（R11）
├── factory.toml                   # [sandbox] [tools] を追加
└── src/
    ├── config.ts                  # [sandbox] [tools] のスキーマを追加 + config.test.ts
    ├── sandbox/
    │   ├── docker.ts              # docker CLI の呼び出し（execa）、作業場の起動・exec・realpath・片付け、残骸の片付け、依存のインストール
    │   ├── options.ts             # 設定から docker run の引数を組み立てる（純粋関数） + options.test.ts
    │   ├── paths.ts               # 名前の上でのパスの正規化（純粋関数） + paths.test.ts
    │   ├── tools.ts               # 4ツール（ToolResult を返す）
    │   ├── testing.ts             # Docker の有無の判定、テスト用の作業ディレクトリ
    │   ├── docker.docker.test.ts  # 作業場と隔離（Docker があるときだけ）
    │   └── tools.docker.test.ts   # 4ツール（Docker があるときだけ）
    └── harness/
        ├── compose.ts             # Guard・ResultTransform の型、composeGuards・composeTransforms + compose.test.ts
        ├── results.ts             # 切り詰めとマスクの整形 + results.test.ts
        └── guards/
            ├── paths.ts           # 作業ディレクトリ外・禁止パスの検査 + paths.test.ts
            └── commands.ts        # 危険なコマンドの形の検査 + commands.test.ts
```

**Structure Decision**: `03` 8章の `sandbox/`（`docker.ts`・`tools.ts`）と `harness/`（`compose.ts`・`guards/`）に置く。`docker run` の引数の組み立てとパスの正規化は純粋関数として分け、Docker なしでテストする。結果の整形は `harness/results.ts` に置く（`03` 8章にない名前なので、設計ドキュメントの8章を同じ変更で直す）。作業場の起動時の残骸の片付け（FR-007）は関数として用意し、呼び出しは常駐の Worker を作る 007 で `main.ts` に入れる（001 の `main.ts` は起動して終了するだけで、Docker がない開発環境で失敗させないため）。

## 設計ドキュメントとの差分

- `03` 5章 サンドボックス: 隔離設定に `.git` の読み取り専用マウント・`HOME=/tmp`・`--init`・`--memory-swap`・ラベルを足し、実行ユーザーの決め方と依存のインストールの作業場を書く
- `03` 8章: `sandbox/options.ts`・`sandbox/paths.ts`・`harness/results.ts`・`harness/guards/paths.ts`・`harness/guards/commands.ts` を足す
- `04` 2章 層3: パスは作業場の中で解決した実際のパスでも確かめること、`.git` への書き込みを拒否すること、`bash` のガードはやわらかい層で禁止パスの変更は層6で検出することを書く。層5に `.git` の読み取り専用を足す
- constitution の変更は要らない（原則 IV の禁止パスに `.git` を足すのは、より厳しくする方向の実装の詳細で、`04` に書けば足りる）

## Complexity Tracking

違反なし。
