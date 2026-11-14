# Implementation Plan: CI連携（ci-feedback）

**Branch**: `009-ci-feedback` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/009-ci-feedback/spec.md`

## Summary

`ci_waiting` のジョブを、CI の結果で先へ進める。内容は6つ。

1. **受付**（`src/http/webhook.ts`・`src/github/events.ts`）: `check_suite`（completed）と `pull_request`（closed）を受け、リポジトリ・作業ブランチ・commit（PR の番号）で `ci_waiting` のジョブに結び付けて「知らせを受けた印」を付け、見回りを起こす。GitHub の API は呼ばずに 202 を返す
2. **見回り**（`src/pipeline/ci.ts`）: Worker とは別のループ。印の付いたジョブと CI 待ちの期限を過ぎたジョブについて、PR の状態とチェックの結果を取り直し、`merged`・`failed`（PR が閉じられた・時間切れ・やり直しの上限）・やり直しの印・通過を決める。PR の本文の CI の欄を書き足す。LLM を使わない
3. **やり直しの取り出し**（`src/queue/jobs.ts`・`src/pipeline/worker.ts`）: Worker は、やり直しの印の付いたジョブを新しい依頼より先に取り出し、`ci_waiting` → `implementing` にする。作業ブランチを取り直し、失敗したチェックのログを取って切り詰め、005 の入口を「計画あり・diff の基準は最初の基準の commit・最初のフィードバックあり」で呼ぶ
4. **ログの切り詰め**（`src/pipeline/ci-log.ts`）: 失敗を示す行の前後だけを残し、伏せ字にして上限以内にする
5. **やり直しの出荷**（`src/pipeline/ship.ts`）: 008 の `shipJob` に「更新」の形を足す。前回の push からの変更を1つの commit にして早送りで push し、出荷前チェックを PR の変更全体で評価し、振り分けは格下げだけ。状態は `judging` → `pr_opened` → `ci_waiting`
6. **諦めたときの引き渡し**（`src/pipeline/report.ts`）: `failJob` で、PR のあるジョブは PR を Draft に変えて本文に理由を書き足す。CI の失敗の分類を足す

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: 001〜008 の依存のまま（octokit 5.0.5 の REST、Hono、execa、TypeBox、Drizzle）。新しい npm の依存は足さない

**Storage**: 001 の SQLite。`jobs` に列を5つ足す（`base_sha`・`head_sha`・`ci_status`・`ci_deadline`・`ci_event_at`。マイグレーション `0004`）。CI の経緯は `job_events`

**Testing**: Vitest。偽の GitHub（チェックの結果・ログ・PR の状態を持たせる）、ローカルの bare リポジトリへの追加の push、偽の 005 の入口、時計の差し替え。GitHub の API と LLM は呼ばない

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービス（単一プロジェクト）

**Performance Goals**: CI の知らせから結論の判断まで 1 分以内（SC-002。見回りは起こされたらすぐ動く）

**Constraints**: 見回りは LLM を使わず、Worker（LLM を使う工程）を待たない。CI のログはデータとして区切りの中に入れ、伏せ字にしてから渡す。強制の push をしない。GitHub 固有の処理は `github/` だけ

**Scale/Scope**: `ci_waiting` のジョブは同時に数件。CI のログは1チェックで数万行まで

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | 見回り・受付は LLM を呼ばない。やり直しの LLM は 005 の入口（予算ゲート経由）だけ | ✅ |
| II. 工程はコードで制御する | CI の結論の決め方・やり直し・諦める条件はコードで決め打ち。遷移は 007 の表のまま（`ci_waiting` → `implementing`・`merged`）。CI のやり直しに上限（`ci_retries`）、CI 待ちに時間の上限（`ci_wait_timeout_minutes`）。失敗は Issue に1回報告してから `failed` | ✅ |
| III. 実装と検査を別モデルにする | やり直しも 005 の判定（検査役）を通す。計画は最初のものを使う | ✅ |
| IV. 隔離と最小権限 | 取り直し・commit・push はホスト。トークンは 007 と同じく環境変数で git に渡す。CI のログはデータとして扱い、伏せ字にしてから実装役に渡す。Webhook は署名の検証のあとに読む | ✅ |
| V. 予算ゲートと計測 | やり直しの LLM は 005 の入口で予算ゲートを通る（ジョブの上限は通算）。CI の経緯を `job_events` に残し、CI 初回通過率を SQL で集計できる | ✅ |
| VI. 品質ゲートと自律レベルB | CI を置き換えず、結果をフィードバックと状態に使うだけ。マージは GitHub。やり直しの出荷前チェックは PR の変更全体で、振り分けは格下げだけ。諦めたら Draft にして人間に渡す | ✅ |
| VII. シンプルさと差し替え可能性 | キューは SQLite のまま。見回りはプロセス内のループで、ミドルウェアを足さない。チェックの結果・ログ・PR の状態は `GitHubPort` に足す（Forgejo に置き換えられる）。`jobs` の列の追加は Complexity Tracking で説明する | ✅ |
| 技術的制約 | octokit（REST）、execa、TypeBox（ペイロードと設定の検証）、Drizzle（マイグレーション） | ✅ |
| 開発ワークフロー | テストで LLM と GitHub を呼ばない。本物の GitHub での確認は AI解禁のあとに手で行う | ✅ |

**Post-design re-check**（Phase 1 のあと）: contracts・data-model を見直した。違反はない。見回りは LLM を使わないので「LLM を使う工程の同時実行1件」に触れない。Draft への変更を `failJob` に入れたことで、007 の起動時の掃除（再起動で中断）でも PR を人間に渡せる。

## Project Structure

### Documentation (this feature)

```text
specs/009-ci-feedback/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── module-api.md     # GitHubPort の追加、見回り、取り出し、取り直し、shipJob の更新の形、ログの切り詰め
│   ├── webhook.md        # check_suite・pull_request の受付の追加
│   ├── factory-toml.md   # [pipeline].max_ci_log_chars・[worker].ci_check_interval_seconds
│   └── report.md         # PR の本文の CI の欄、CI の失敗の報告、実装役への CI のフィードバック
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── drizzle/0004_ci_feedback.sql          # jobs の列の追加
├── factory.toml                          # max_ci_log_chars・ci_check_interval_seconds
└── src/
    ├── config.ts                         # 上の2項目 + config.test.ts
    ├── main.ts                           # 見回りの起動と停止、受付に起こし方を渡す
    ├── queue/
    │   ├── schema.ts                     # jobs の列 + schema.test.ts
    │   └── jobs.ts                       # claimNextJob（やり直しを先に）、CI の印の操作 + jobs.test.ts
    ├── github/
    │   ├── port.ts                       # getPullRequest・getCheckRuns・getCheckRunLog、CiEvent
    │   ├── client.ts                     # 本物（REST）
    │   ├── testing.ts                    # 偽物に同じ操作を足す
    │   ├── events.ts                     # check_suite・pull_request の絞り込み + events.test.ts
    │   └── git.ts                        # cloneBranchForRetry + git.test.ts
    ├── http/webhook.ts                   # CI の知らせを結び付けて印を付ける + webhook.test.ts
    ├── harness/context.ts                # DATA_TAGS に ci_log（区切りのタグ）
    └── pipeline/
        ├── ci.ts                         # 見回り（結論の判断・時間切れ・マージ・PR の本文） + ci.test.ts
        ├── ci-log.ts                     # ログの切り詰めと CI のフィードバックの組み立て + ci-log.test.ts
        ├── run.ts                        # PipelineInput に planObject・baseCommit・initialFeedback・preflightChecks + run.test.ts
        ├── ship.ts                       # 更新の形（早送りの push・格下げだけ・CI の印） + ship.test.ts
        ├── report.ts                     # CI の欄、CI の失敗の分類、failJob での Draft への引き渡し + report.test.ts
        └── worker.ts                     # やり直しの取り出しと実行 + worker.test.ts
```

**Structure Decision**: GitHub の API とペイロードは `github/`（原則 VII）。CI の結論の判断は GitHub に依存しない形（`CheckRunInfo` の一覧）にして `pipeline/ci.ts` に置く（03 8章で予定していた場所）。ログの切り詰めは LLM の入力を作る部品なので `pipeline/ci-log.ts`。やり直しの実行は Worker の中（LLM を使う工程は Worker だけが回す）。

## 設計ドキュメントとの差分

同じ変更で直す。

- `03` 3章: `ci_waiting` で受ける知らせ（`check_suite`・`pull_request`）、見回り（Worker と別のループ）、CI の結論の決め方、CI 通過後は `ci_waiting` のままマージの知らせで `merged`、やり直しの合格のあと `judging` → `pr_opened` → `ci_waiting`、諦めたら Draft を足す
- `03` 4章 #8 CI待ち: 結論はチェックをすべて取り直して決める、失敗したらログを失敗箇所の前後に切り詰めて4へ戻す（作業ブランチを取り直し、PR の変更全体を前回の diff として渡す）、時間切れでの取り直し、上限で Draft にして人間に渡すことを足す
- `03` 4章 #9 マージ: `pull_request` の closed（マージ済み）で `merged` に進めることを足す
- `03` 5章 データ・キュー: `jobs` の CI の列
- `03` 8章: `pipeline/ci.ts`・`pipeline/ci-log.ts` を足し、`github/` の「後で CIログ取得」を実際の内容にする
- `04` 3章 フィードバック（CI）: 工程内テストを先に回して再現しないことを伝える、計画を引き継ぐ、作業ブランチの取り直しを足す

## Complexity Tracking

| 違反（に見えるもの） | 必要な理由 | 簡単な代替を採らなかった理由 |
|---|---|---|
| `jobs` に列を5つ足す | 知らせの結び付け（`head_sha`）、やり直しの基準（`base_sha`）、見回りの対象の選び出し（`ci_status`・`ci_deadline`・`ci_event_at`）を、1文の UPDATE の条件で重複なく扱うため | `job_events` の JSON から都度読む → 見回りのたびに全ジョブの記録を読み、二重のやり直しを防ぐ条件付きの更新が書けない |
| 見回りのループを Worker と別に持つ | `ci_waiting` はワーカーを占有しない（`03` 3章）。Worker が 60 分の実装工程を回している間も CI の結論を 1 分以内に扱う（SC-002） | 受付の応答のあとの処理で判断する → 時間切れの見回りが別に要る。見回りに1本化した方が、取りこぼしの拾い直しと同じ経路になる |
