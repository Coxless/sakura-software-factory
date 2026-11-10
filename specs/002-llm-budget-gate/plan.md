# Implementation Plan: LLM層と予算ゲート（llm-budget-gate）

**Branch**: `002-llm-budget-gate` | **Date**: 2026-11-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-llm-budget-gate/spec.md`

## Summary

すべての LLM 呼び出しが通る1本の道を作り、さくらのAI Engine で実装役のツール呼び出しが動くかを実機で確かめる。内容は4つ。

1. **提供元の登録**: pi-ai 1.5.0 の `createProvider` で さくらを `openai-completions` の提供元にする。互換フラグは `developer` ロールなし・`max_tokens` などで始め、スモークテストで決める
2. **予算ゲート**: pi-agent-core の `StreamFn` の形のラッパー。試行ごとに「予算の確認 → 1回送る → `llm_calls` に1件」を行い、一時的な失敗だけを再試行する。Pi の内部リトライは `maxRetries: 0` で止め、HTTP の状態コードは差し替えた `fetch` で捕まえる。途中までの応答は流さず、成功した試行のイベントだけを流す
3. **偽の LLM**: OpenAI互換の SSE / JSON を返す偽の `fetch`。本物のアダプターを通したまま、429・500・切断・ツール呼び出しを再現する
4. **スモークテスト**: `pnpm run smoke:llm`。Pi 経由と素の HTTP の両方で6項目を確かめ、結果で Pi を続けるか TanStack AI に切り替えるかを決める

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: 001 の依存に加えて `@earendil-works/pi-ai` 1.5.0、`@earendil-works/pi-agent-core` 1.5.0（完全に固定。[research.md](./research.md) R1）。HTTP は Node 標準の `fetch`

**Storage**: 001 の SQLite。`llm_calls` に `error_kind` 列を足すマイグレーション1つ（R10）

**Testing**: Vitest。偽の `fetch` と `:memory:` の DB。待ち時間は注入した `sleep` で飛ばす。さくらのAI Engine はスモークテスト（手動）でだけ呼ぶ

**Target Platform**: Linux（Workshop `dev`、本番は さくらのVPS）

**Project Type**: 常駐サービスの中のライブラリ層＋手動の CLI 1つ

**Performance Goals**: ゲートの自動テストが10秒以内（SC-006）。スモークテストが10リクエスト以下、正常時は2分以内（SC-001）

**Constraints**: 月3,000リクエスト。LLM を使う工程の同時実行は1件（予算の確認と記録の間で排他しない）。ゲートを迂回する経路を作らない

**Scale/Scope**: 新規ファイルは `src/llm/` の4つ（＋テスト）と `src/smoke-llm.ts`。設定項目3つ、列1つ

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | 本番の提供元は さくら1つだけ。開発中だけ Google AI Studio を `factory.dev.toml` で選べる（1.2.0 の例外。`pnpm start` は さくら以外で起動しない、記録は別の DB、送るのは公開データだけ）。URL・モデル名は `factory.toml` から読み、コードに書かない。OpenAI互換（Chat Completions）で呼ぶ。退避先へは設定変更でだけ切り替える（自動切り替えしない） | ✅ |
| II. 工程はコードで制御する | 再試行の回数に上限（`max_attempts`）と時間の上限（`request_timeout_seconds`）を設ける。予算切れは機械で読める形で返し、`failed` への遷移は 007 の状態機械が行う | ✅ |
| III. 実装と検査を別モデルにする | 役割ごとに設定のモデル名を引く。`tools` を渡さないことは 005 が守る（本機能では制限しない）。`response_format` は使わない | ✅ |
| IV. 隔離と最小権限 | APIキーは環境変数 `SAKURA_AI_API_KEY` からホストのプロセスだけが読む。エラー文はパターンと APIキーの値の両方でマスクしてから記録する。コンテナは関わらない | ✅ |
| V. 予算ゲートと計測 | すべての呼び出しが `runGated` を通る（`StreamFn` も素の HTTP も）。試行の前に毎回、月とジョブの残量を確かめる。試行1回に `llm_calls` 1件（失敗・取り消しも）。リトライはゲートだけで行い、Pi の内部リトライは0にする。`setDefaultStreamFn` で素通りを塞ぐ。受付の可否の関数を用意する | ✅ |
| VI. 品質ゲートと自律レベルB | 関係なし。スモークテストは `pnpm run check` に含めない | ✅ |
| VII. シンプルさと差し替え可能性 | 新しいミドルウェアなし。HTTP は標準の `fetch`。偽の LLM は自前の偽 `fetch` 1つ（pi-ai の `fauxProvider` と二重に持たない）。TanStack AI へ切り替えるときに書き直すのは `provider.ts` と `stream.ts` の内側の呼び出しだけで、`runGated`・`budget.ts`・記録は残る | ✅ |
| 技術的制約 | Pi は `@earendil-works/*` を完全固定。TypeBox（スモークテストの引数の検証）。Zod なし | ✅ |
| 開発ワークフロー | テストで さくらのAI Engine を呼ばない。偽の LLM はゲートの内側に差し込む偽の `fetch`（constitution 1.0.1 で「偽の `streamFn`」から文言を改めた）。試行錯誤（スモークテストの結果と判断）を `docs/journal/` に残す | ✅ |

**Post-design re-check**（Phase 1 のあと）: data-model・contracts を見直した。`runGated` を中核にして `StreamFn` と素の HTTP の両方を通すことで、スモークテストの `--raw` も原則 V を満たす。違反はない。Complexity Tracking は空。

## Project Structure

### Documentation (this feature)

```text
specs/002-llm-budget-gate/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── module-api.md     # 後続機能に渡す関数と型
│   ├── commands.md       # pnpm run smoke:llm
│   └── factory-toml.md   # [llm] の追加項目と環境変数
├── checklists/
│   └── requirements.md
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── package.json             # + @earendil-works/pi-ai 1.5.0, @earendil-works/pi-agent-core 1.5.0、scripts に smoke:llm
├── factory.toml             # [llm] に max_attempts などを追記。スモークテスト後に base_url・モデル名を直す
├── factory.dev.toml         # 開発用（provider = "google-ai-studio"、別の DB）
├── drizzle/                 # + llm_calls.error_kind のマイグレーション
└── src/
    ├── config.ts            # [llm] に3項目（既定値つき）  + config.test.ts
    ├── smoke-llm.ts         # pnpm run smoke:llm（引数の解析・6項目・表/JSON 出力・終了コード）  + smoke-llm.test.ts（runSmokeCli の終了コード）
    ├── queue/
    │   └── schema.ts        # llm_calls に error_kind（CHECK つき）、LLM_ERROR_KINDS
    └── llm/
        ├── provider.ts      # createLlmModels, modelForRole, providerOf, assertProductionProvider, DEFAULT_SAKURA_COMPAT  + provider.test.ts
        ├── budget.ts        # checkBudget, canAcceptNewJob, ensureBudgetMonth, BudgetExceededError  + budget.test.ts
        ├── stream.ts        # runGated, createGatedStreamFn, 失敗の分類, getBudgetExceeded, installStreamFnGuard  + stream.test.ts
        ├── smoke.ts         # スモークテストの確認項目（Pi 経由・素の HTTP）。CLI から分けてテストできるようにする  + smoke.test.ts（偽の fetch で）
        └── testing.ts       # createFakeLlm, createTestGateDeps（テスト専用）
```

**Structure Decision**: 単一プロジェクト。`03` 8章の `src/llm/`（provider.ts・stream.ts・budget.ts）に合わせ、偽の LLM（testing.ts）とスモークテストの中身（smoke.ts）を足す。CLI の入口は 001 の `migrate.ts` と同じく `src/` 直下に置く。件数の集計は 001 の `queue/llm-calls.ts` を使い、判断は `llm/budget.ts` が持つ（001 で決めた分担）。

## 設計ドキュメントとの差分

- `03` 8章の `llm/` に `smoke.ts`・`testing.ts` を、`src/` に `smoke-llm.ts` を足す
- `03` 7章の `llm_calls` の列に `error_kind` を足す。constitution 原則 V は「最低限記録する列」を定めたもので、列を足しても違反にならないため改定しない
- `03` 5章の設定の項目に「LLM のリトライ上限・待ち時間の上限・応答の時間の上限」を足す
- `03` 4章・5章の「偽の `streamFn`」を「ゲートの内側に差し込む偽の `fetch`」に改める（research R13。constitution 1.0.1 と同時に直した）
- 上の差分は実装に入る前（tasks の最初）に `docs/design/03` へ反映する
- スモークテストの結果、TanStack AI へ切り替えることになったら、`03` 0章・5章と constitution の技術的制約を直してから 004 に進む

## Complexity Tracking

違反なし。
