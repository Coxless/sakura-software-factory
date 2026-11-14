# Implementation Plan: ステージングデプロイ（staging-deploy）

**Branch**: `010-staging-deploy` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/010-staging-deploy/spec.md`

## Summary

main への push を受けて、デモアプリをステージングに出す。内容は6つ。

1. **受付**（`src/http/webhook.ts`・`src/github/events.ts`）: `push` を受け、`[staging].repo` の既定のブランチへの push だけを `deployments` に `queued` で積み、デプロイの実行器を起こす。GitHub の API は呼ばずに 202 を返す
2. **実行器**（`src/deploy/runner.ts`）: Worker・CI の見回りと別のループ。積んだ順に1件ずつ、ジョブの結び付け → 取得 → ビルド → compose の入れ替え → ヘルスチェック → 成功（`deployed`）またはロールバック（`rolled_back`）。LLM は使わない
3. **Docker の操作**（`src/deploy/staging.ts`・`src/deploy/health.ts`・`deploy/staging/compose.yaml`）: `docker build`・`docker compose up/down`・イメージの有無と片付け。ヘルスチェックは `fetch` で「続けて N 回 200」
4. **ロールバックと revert PR**（`src/deploy/runner.ts`・`src/github/git.ts`）: 直前に成功したイメージに戻して確かめ、push の範囲を打ち消す commit を新しいブランチに積んで通常の PR を作る
5. **記録とレポート**（`src/queue/deployments.ts`・`src/pipeline/report.ts`）: `deployments` の列と状態を足す（マイグレーション `0005`）。PR の本文のデプロイの欄、ロールバックの Issue への報告、`deploy_failed`
6. **起動と停止**（`src/main.ts`）: 途中のデプロイの掃除、既定のブランチの先頭の取り直し、停止の順。デモ用の対象リポジトリ（`Coxless/factory-sandbox`）の準備

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: 001〜009 の依存のまま（octokit 5.0.5 の REST、Hono、execa、TypeBox、Drizzle）。新しい npm の依存は足さない。ホストに Docker と `docker compose`（Ubuntu の `docker-compose-v2`。VPS は 006 の `setup.sh` で入る。Workshop の `setup-base` に足す）

**Storage**: 001 の SQLite。`deployments` を作り直して列と状態を足す（マイグレーション `0005`。まだ1行も書かれていない）。経緯は `job_events`

**Testing**: Vitest。偽の `StagingRuntime`・偽の GitHub・ローカルの bare リポジトリ（取得と revert の push）・偽の `fetch`（ヘルスチェック）・時計の差し替え。本物の Docker のテストは `*.docker.test.ts`（なければ飛ばす。CI では飛ばさない）

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービス（単一プロジェクト）

**Performance Goals**: push の知らせからデプロイの開始まで 1 分以内（SC-003。実行器は起こされたらすぐ動く）

**Constraints**: LLM を使わない。ビルド・compose・コンテナにファクトリーの秘密情報を渡さない。ステージングはループバックにだけ公開し、別のネットワーク・リソースの制限で動かす。revert の push は強制しない。GitHub 固有の処理は `github/` だけ

**Scale/Scope**: push は1日に数件。デモアプリは依存のない Node の HTTP サーバー（イメージは数百 MB、ビルドは数十秒）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | デプロイは LLM を呼ばない。ステージングは VPS で動かす | ✅ |
| II. 工程はコードで制御する | `merged` → `deploying` → `deployed` / `rolled_back` は 007 の状態の表のまま。ビルド・ヘルスチェックに時間の上限。失敗（取得・ビルド・中断）は Issue に1回報告して `failed`、ロールバックも1回報告 | ✅ |
| III. 実装と検査を別モデルにする | 触れない。revert PR は検査役を通っていないので auto-merge を有効にしない | ✅ |
| IV. 隔離と最小権限 | 取得・commit・push はホスト（トークンは環境変数の `http.extraHeader`）。docker の子プロセスの環境を絞り、ビルド・コンテナに秘密情報を渡さない。ステージングは別のネットワーク・非 root・読み取り専用・制限付き。Webhook は署名の検証のあとに読む | ✅ |
| V. 予算ゲートと計測 | LLM を呼ばないので予算を使わない。`deployments` にデプロイ1件ごとの結果・ロールバックを残し、成功率を SQL で集計できる | ✅ |
| VI. 品質ゲートと自律レベルB | ステージングへの自動デプロイ（レベルB）。ヘルスチェックの失敗で直前のイメージに戻し revert PR を作る（MUST）。本番には触れない | ✅ |
| VII. シンプルさと差し替え可能性 | キューは SQLite の `deployments`。実行器はプロセス内のループで、ミドルウェアを足さない。push・PR の特定・既定のブランチの先頭は `GitHubPort` に足す。Docker の操作は `StagingRuntime` にまとめる | ✅ |
| 技術的制約 | ステージングは VPS のファクトリーが push を受けてデプロイ（Actions から SSH しない）。execa・TypeBox・Drizzle | ✅ |
| 開発ワークフロー | テストで GitHub・LLM を呼ばない。本物の Docker のテストは CI で必ず回す | ✅ |

**Post-design re-check**（Phase 1 のあと）: contracts・data-model を見直した。違反はない。対象のリポジトリの Dockerfile をホストの Docker でビルドするのは、作業場（原則 IV のツールの実行）とは別の工程で、CI を通ってマージされたコードだけを、秘密情報なしで BuildKit のコンテナの中で動かす（Complexity Tracking）。

## Project Structure

### Documentation (this feature)

```text
specs/010-staging-deploy/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── module-api.md     # GitHubPort の追加、取得と revert、deployments の操作、StagingRuntime、ヘルスチェック、実行器
│   ├── webhook.md        # push の受付の追加
│   ├── factory-toml.md   # [staging]
│   ├── staging.md        # compose の定義とデモアプリの約束
│   └── report.md         # PR の本文のデプロイの欄、ロールバックの報告、revert PR
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── .workshop/devtools/hooks/setup-base   # docker-compose-v2
├── deploy/
│   ├── staging/compose.yaml              # ステージングの compose（新規）
│   └── README.md                         # ステージングの節
├── drizzle/0005_staging_deploy.sql       # deployments の作り直し
├── factory.toml                          # [staging]
└── src/
    ├── config.ts                         # [staging] + config.test.ts
    ├── main.ts                           # 実行器の起動・停止、起動時の掃除と取り直し + main.test.ts
    ├── queue/
    │   ├── schema.ts                     # deployments の列・状態 + schema.test.ts
    │   └── deployments.ts                # 積む・取り出す・終わらせる・掃除 + deployments.test.ts（新規）
    ├── github/
    │   ├── port.ts                       # findMergedPullRequest・getDefaultBranchHead、PushEvent
    │   ├── client.ts                     # 本物（REST）
    │   ├── testing.ts                    # 偽物に同じ操作を足す、mergeCommitSha
    │   ├── events.ts                     # toPushEvent + events.test.ts
    │   └── git.ts                        # fetchCommit・revertRange + git.test.ts
    ├── http/webhook.ts                   # push を積む + webhook.test.ts
    ├── deploy/                           # 新規
    │   ├── staging.ts                    # StagingRuntime（docker build・compose・イメージ）
    │   ├── staging.docker.test.ts        # 本物の Docker
    │   ├── health.ts                     # waitHealthy + health.test.ts
    │   ├── runner.ts                     # 実行器 + runner.test.ts
    │   └── testing.ts                    # 偽の StagingRuntime
    └── pipeline/
        ├── ci.ts                         # markMerged を切り出す
        └── report.ts                     # deploy_failed、デプロイの欄、ロールバックの報告、revert PR の本文 + report.test.ts
```

**Structure Decision**: `03` 8章の予定どおり、Docker の操作は `deploy/`（`staging.ts`）、GitHub の API とペイロードは `github/`（原則 VII）。実行器は Worker と別のループなので `deploy/runner.ts` に置く（`pipeline/deploy.ts` の予定を、Docker の操作と同じ層にまとめる形に変える）。レポートの文面は 007〜009 と同じく `pipeline/report.ts` にまとめる。

## 設計ドキュメントとの差分

同じ変更で直す。

- `03` 3章: デプロイの実行器（Worker と別のループ、1件ずつ）、`ci_waiting` のまま push が先に届いたときの扱い、ビルドの失敗は `failed`、起動時の掃除（`deploying` は `failed`）と取り直しを足す
- `03` 4章 #10 デプロイ: 対象のリポジトリ（`[staging].repo`）の既定のブランチだけ、ジョブとの結び付け（マージ commit）、ヘルスチェックの決め方、ロールバックの戻し先（直前に成功したデプロイ）、revert PR は通常の PR（auto-merge なし）を足す
- `03` 4章 #11 レポート: デプロイの欄、ロールバックの Issue への報告
- `03` 5章 ステージング: compose の定義（ファクトリーのリポジトリに固定）、隔離の設定、docker の子プロセスの環境、イメージの名前と片付け。データ・キュー: `deployments` の列
- `03` 8章: `deploy/`（`runner.ts`・`staging.ts`・`health.ts`）、`pipeline/deploy.ts` を消す、`github/` の push・revert
- `04` 2章 層9: ヘルスチェックの決め方と revert PR は人間がマージすることを足す
- `deploy/README.md`: ステージングの節（`502` の注記を直す）

## Complexity Tracking

| 違反（に見えるもの） | 必要な理由 | 簡単な代替を採らなかった理由 |
|---|---|---|
| 対象のリポジトリの Dockerfile を、作業場ではなくホストの Docker でビルドする（ネットワークあり） | ステージングのイメージは依存の取得にネットワークが要る。ビルドするのはブランチ保護の CI を通ってマージされたコードだけで、ビルドは BuildKit のコンテナの中で動き、ファクトリーの秘密情報を渡さない（子プロセスの環境を絞る） | 作業場（`--network none`）でビルド → 依存を取れない。Actions でビルドして push → `03` の決定（Actions から SSH しない・VPS 側で受ける）と、レジストリの認証情報の置き場所が増える |
| デプロイの実行器を Worker・見回りと別のループで持つ | Worker が実装工程を回している間も、push から 1 分以内に始める（SC-003）。LLM を使わないので同時実行1件の制約の外 | Worker の中でデプロイ → 実装工程（最大 60 分）の間、ステージングが止まって見える |
| `deployments` を作り直す（列 7 つと状態を足す） | 積んだ順の取り出し・同じ commit の重複の防止・ロールバックの成功率の集計を SQL で行う（SC-006） | `job_events` だけで持つ → 人間の push（ジョブなし）を記録できない |
