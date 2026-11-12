# Implementation Plan: 受付とジョブキュー（github-intake）

**Branch**: `007-github-intake` | **Date**: 2026-11-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/007-github-intake/spec.md`

## Summary

Issue の `@agent` コメントから、005 の工程を回すまでをつなぐ。内容は5つ。

1. **GitHub 層**（`src/github/`）: App の認証とインストールトークン、署名の検証、権限の確認、リアクション、コメント。GitHub の型と SDK はこの中だけで使う
2. **受付**（`POST /webhook`）: 署名 → 対象の絞り込み → `@agent` の判定 → 権限 → 予算 → `jobs` に積む → `202`。リアクションとコメントは応答のあと
3. **状態機械**（`src/pipeline/state.ts`）: `03` 3章の遷移の表と、記録付きの遷移
4. **Worker**（`src/pipeline/worker.ts`）: 1件ずつ取り出し、取得（トークンは環境変数で git に渡し、どこにも書き残さない）→ 作業ブランチ → 依存のインストール → 005 の入口（`PipelinePort`）→ 報告 → 片付け。時間の上限、起動時の掃除、停止
5. **失敗の報告**（`src/pipeline/report.ts`）: 1回だけ、秘密情報を伏せて Issue に投稿する。008 までは合格したジョブも `failed`（出荷の工程が未実装）

005 の入口の形は未定なので、007 は `PipelinePort` の型で受け取り、テストでは偽物を使う（[research.md](./research.md) R2）。

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: 001〜006 の依存に加えて octokit 5.0.5・@octokit/webhooks 14.2.0（完全固定）。git CLI（execa）

**Storage**: 001 の SQLite（`jobs`・`job_events`・`budget`。スキーマは変えない）。作業ディレクトリは `[storage] work_dir`

**Testing**: Vitest。記録した Webhook のペイロード（`src/github/fixtures/`）、偽の GitHub（`src/github/testing.ts`）、偽の 005 の入口、ローカルの bare リポジトリ（`file://` で取得）。GitHub の API と本物の LLM は呼ばない

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービス（単一プロジェクト）

**Performance Goals**: Webhook への応答 1 秒以内（SC-004。権限の確認の API 1回を含む）

**Constraints**: LLM を使う工程は同時に1件。トークンを作業ディレクトリ・作業場・ログ・報告に出さない。GitHub 固有の処理は `github/` だけ

**Scale/Scope**: 依頼は1日に数件〜数十件。対象リポジトリは App を入れた数個

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | 受付は LLM を呼ばない。005 の工程は 002 の予算ゲートを通る。常駐は `provider = "sakura"` だけ（006 のまま） | ✅ |
| II. 工程はコードで制御する | 遷移の表で決め打ち。ジョブ全体の時間に上限。失敗時は Issue に1回報告してから `failed` | ✅ |
| III. 実装と検査を別モデルにする | 005 の責務。007 は触らない | ✅ |
| IV. 隔離と最小権限 | 署名を定数時間比較してから処理。書き込み権限＋許可ユーザーだけ。GitHub App の短命トークン（PAT なし）。トークンは環境変数で git に渡し、作業ディレクトリ・作業場に入れない。Issue 本文と依頼の本文はデータとして扱う | ✅ |
| V. 予算ゲートと計測 | 月の残りが1ジョブの上限を下回ったら受け付けない（`canAcceptNewJob`）。受付を止めた時刻を `budget` に書く。報告に消費したリクエスト数を入れる | ✅ |
| VI. 品質ゲートと自律レベルB | 008 までは出荷しない（合格しても PR を作らず、理由を付けて終える） | ✅ |
| VII. シンプルさと差し替え可能性 | キューは SQLite の `jobs`（001）。受信箱のテーブルは作らない。GitHub は `github/` 層だけ（Forgejo に置き換えられる）。005 は `PipelinePort` で差し替えられる | ✅ |
| 技術的制約 | Hono・octokit・@octokit/webhooks・execa・TypeBox（Webhook のペイロードの絞り込み） | ✅ |
| 開発ワークフロー | テストで LLM と GitHub を呼ばない。本物の GitHub での確認はテスト用のリポジトリで手で行う | ✅ |

**Post-design re-check**（Phase 1 のあと）: contracts・data-model を見直した。違反はない。

## Project Structure

### Documentation (this feature)

```text
specs/007-github-intake/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── webhook.md        # POST /webhook の入力・判定・応答
│   ├── github-app.md     # App の権限・イベント・環境変数・作り方
│   ├── factory-toml.md   # [github] [worker] [storage] の追加分
│   ├── module-api.md     # PipelinePort、GitHub 層、Worker の関数と型
│   └── report.md         # Issue へのコメントの文面
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── factory.toml                     # [github] [worker] の追加、[storage] work_dir
├── deploy/
│   ├── factory.env.example          # GITHUB_APP_ID・GITHUB_APP_PRIVATE_KEY_PATH・GITHUB_WEBHOOK_SECRET
│   ├── scripts/setup.sh             # 必須の環境変数・秘密鍵のファイルの確認、work_dir の書き換え
│   └── README.md                    # GitHub App の作り方と、秘密鍵の置き方
└── src/
    ├── config.ts                    # 追加の項目 + config.test.ts
    ├── main.ts                      # GitHub 層・Worker の組み立て、起動時の掃除、停止
    ├── http/
    │   ├── app.ts                   # /webhook を足す
    │   └── webhook.ts               # 受付の流れ（署名 → 判定 → 権限 → 予算 → 積む） + webhook.test.ts
    ├── github/
    │   ├── client.ts                # GitHubPort の本物（octokit の App）
    │   ├── signature.ts             # 署名の検証（@octokit/webhooks） + signature.test.ts
    │   ├── events.ts                # ペイロードの絞り込み（TypeBox）と依頼の取り出し + events.test.ts
    │   ├── git.ts                   # トークンを環境変数で渡す clone・ブランチ作成 + git.test.ts
    │   ├── testing.ts               # 偽の GitHubPort、署名付きの要求を作る関数
    │   └── fixtures/                # 記録した Webhook のペイロード（個人情報を除いたもの）
    ├── queue/
    │   └── jobs.ts                  # enqueueJob、受付を止めた時刻、起動時の掃除の問い合わせを足す + jobs.test.ts
    └── pipeline/
        ├── state.ts                 # 遷移の表と transition() + state.test.ts
        ├── worker.ts                # Worker、PipelinePort、1件の処理、起動時の掃除、停止 + worker.test.ts
        └── report.ts                # 報告の本文と1回だけの投稿 + report.test.ts
```

**Structure Decision**: `03` 8章の `github/`・`http/`・`pipeline/`（`state.ts`・`report.ts`）・`queue/` に置く。受付の流れは `http/webhook.ts` に置き、GitHub の型は `github/events.ts` で受付用の小さな型（`AgentRequest`）に変えてから渡す（原則 VII）。Worker は 005 の工程と 008 以降の工程を呼ぶ側なので `pipeline/` に置く。`pipeline/report.ts` は 007 で失敗の最小版、008 で完成させる。

## 設計ドキュメントとの差分

同じ変更で直す。

- `03` 4章 #1: 依頼の形（最初の空でない行が `@agent`）、権限のない依頼に返事をしないこと、リアクションは `eyes` であることを足す
- `03` 5章 GitHub 連携: 環境変数の名前、秘密鍵はファイルで渡すこと、トークンは環境変数で git に渡し `.git/config` に書かないことを足す
- `03` 5章 データ・キュー: 受信箱のテーブルを持たないこと（GitHub は自動で再送しないので、失敗は配送の ID をログに残し、運用者が手で再送する）を足す
- `03` 8章: `http/webhook.ts`・`github/`（`client.ts`・`signature.ts`・`events.ts`・`git.ts`）・`pipeline/worker.ts` を足す
- `04` 2章 層1: 引用・コードの中の `@agent`、ボットのコメントを依頼にしないことを足す
- constitution の変更は要らない

## Complexity Tracking

違反なし。
