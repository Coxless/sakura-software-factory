# Implementation Plan: 出荷とレポート（ship-and-report）

**Branch**: `008-ship-and-report` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/008-ship-and-report/spec.md`

## Summary

判定に合格したジョブを、PR にして `ci_waiting` まで進める。内容は5つ。

1. **commit**（`src/github/git.ts`）: 作業ディレクトリの変更（005 の diff と同じ範囲）を、フックとホストの git の設定を外して、App のボットの名前で1つの commit にする
2. **出荷前チェック**（`src/pipeline/ship-checks.ts`）: commit を対象に6条件をすべて評価する。gitleaks は基準のコミットの設定で呼び、インラインの許可（`gitleaks:allow`）と「走査していない」を見逃さない。秘密情報・CI の定義の変更では push しない
3. **push と PR**（`src/github/git.ts`・`src/github/client.ts`）: トークンを環境変数で渡して作業ブランチだけを push し、PR を作る。6条件を満たせば auto-merge（squash）、満たさなければ Draft。auto-merge を有効にできなければ Draft に変える
4. **出荷の工程**（`src/pipeline/ship.ts`）: 上の3つを順に呼び、`judging` → `pr_opened` → `ci_waiting` に進め、振り分けを記録する。Worker は 005 の `passed` でこれを呼び、007 の `shipping_not_available` を置き換える
5. **まとめレポート**（`src/pipeline/report.ts`）: PR の本文に6条件の表と振り分けの理由を書き、Issue に PR へのリンクを1回コメントする。出荷前に止めたら 007 の失敗の報告

AI解禁の前に本物の GitHub で出荷の工程だけを試すため、開発用の CLI `pnpm run ship:dev` を足す（[research.md](./research.md) R10）。

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: 001〜007 の依存のまま（octokit 5.0.5 の REST と GraphQL、execa、TypeBox）。新しい npm の依存は足さない。gitleaks 8.30.1（006 で開発環境・CI・VPS に入れたもの）

**Storage**: 001 の SQLite（`jobs.pr_number`・`job_events`。スキーマは変えない）

**Testing**: Vitest。ローカルの bare リポジトリ（`file://`）への push、偽の GitHub（`src/github/testing.ts` に PR・auto-merge・Draft・ラベル・ボットの名前を足す）、本物の gitleaks（Workshop・CI に入っている。見つからなければそのテストは飛ばさず失敗にする）。GitHub の API と LLM は呼ばない

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービス（単一プロジェクト）

**Performance Goals**: 判定に合格してから PR ができるまで 1 分以内（SC-005。gitleaks のスキャンは1つの commit だけ）

**Constraints**: 出荷は LLM を呼ばない。トークンと見つかった秘密情報の値を、作業ディレクトリ・PR・コメント・ログ・記録に出さない。作業ディレクトリのフック・設定を実行・信用しない。GitHub 固有の処理は `github/` だけ

**Scale/Scope**: 出荷は1日に数件〜数十件。diff は上限（既定 300 行）前後

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | 出荷は LLM を呼ばない。`ship:dev` も LLM を呼ばない | ✅ |
| II. 工程はコードで制御する | 6条件の評価と振り分けはコードで決め打ち。状態は表のとおり `judging` → `pr_opened` → `ci_waiting`。出荷前の失敗は Issue に1回報告してから `failed` | ✅ |
| III. 実装と検査を別モデルにする | 検査役の合格を条件1として使う（005 の結果）。出荷で判定し直さない | ✅ |
| IV. 隔離と最小権限 | commit・push はホスト。作業場にトークンを渡さない。トークンは環境変数で git に渡す。作業ディレクトリのフック・設定・gitleaks の許可を使わない。`.github/workflows` を変えた diff は push しない（App に Workflows の権限なし） | ✅ |
| V. 予算ゲートと計測 | LLM を呼ばない（消費 0）。レポートに消費したリクエスト数を書く。振り分けを `job_events` に残し、記事の集計に使う | ✅ |
| VI. 品質ゲートと自律レベルB | auto-merge は6条件をすべて満たすときだけ。1つでも外れたら Draft。マージは GitHub のブランチ保護に任せ、ファクトリーはマージしない。レポートに条件ごとの結果を書く | ✅ |
| VII. シンプルさと差し替え可能性 | スキーマを変えない（`pr_number` は 001 の列、振り分けは `job_events`）。新しい依存なし。PR・auto-merge・ラベル・ボットの名前は `GitHubPort` に足す（Forgejo に置き換えられる）。gitleaks は GitHub に依存しないので `pipeline/` に置く | ✅ |
| 技術的制約 | octokit（REST・GraphQL）、execa、TypeBox（設定の検証） | ✅ |
| 開発ワークフロー | テストで LLM と GitHub を呼ばない。本物の GitHub での確認はテスト用のリポジトリで `ship:dev` を使って手で行う | ✅ |

**Post-design re-check**（Phase 1 のあと）: contracts・data-model を見直した。違反はない。`ship:dev` は開発用の CLI で、常駐のファクトリーの起動経路には入らない（原則 I の「常駐は さくら以外で起動しない」に触れない）。

## Project Structure

### Documentation (this feature)

```text
specs/008-ship-and-report/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── module-api.md     # GitHubPort の追加、commit・push、出荷前チェック、shipJob、Worker の変更
│   ├── factory-toml.md   # [auto_merge] の追加分（skip_label、既定の禁止パス）
│   ├── report.md         # PR の本文（まとめレポート）、Issue のコメント、失敗の報告の追加分
│   └── ship-dev.md       # 開発用の CLI の引数と出力
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── factory.toml                     # [auto_merge] skip_label、forbidden_paths に .gitleaks.toml・.gitleaksignore
├── package.json                     # ship:dev
└── src/
    ├── config.ts                    # [auto_merge] skip_label、既定の禁止パス + config.test.ts
    ├── main.ts                      # Worker に出荷の依存（gitleaks の場所など）を渡す
    ├── ship-dev.ts                  # 開発用の CLI（R10） + ship-dev.test.ts
    ├── github/
    │   ├── port.ts                  # GitHubPort に PR・auto-merge・Draft・ラベル・ボットの名前を足す
    │   ├── client.ts                # 本物（REST・GraphQL）
    │   ├── testing.ts               # 偽物に同じ操作を足す
    │   └── git.ts                   # commitForJob・pushBranch・changedFiles + git.test.ts
    └── pipeline/
        ├── ship-checks.ts           # 6条件の評価、gitleaks の呼び出し + ship-checks.test.ts
        ├── ship.ts                  # shipJob（commit → チェック → push → PR → 振り分け → 状態 → 報告） + ship.test.ts
        ├── report.ts                # まとめレポート、Issue の知らせ、失敗の分類の追加 + report.test.ts
        └── worker.ts                # passed で shipJob を呼ぶ。classifyOutcome から shipping_not_available を消す + worker.test.ts
```

**Structure Decision**: GitHub の API と git の push は `github/`（原則 VII）。gitleaks と6条件の評価は GitHub に依存しないので `pipeline/ship-checks.ts`。出荷の流れ（状態・記録・報告）は Worker から呼ぶ `pipeline/ship.ts` に置き、Worker には「`passed` なら `shipJob`」の分岐だけを足す。commit は push と同じく GitHub のトークンの近くで扱うので `github/git.ts` に置く（トークンは使わない）。

## 設計ドキュメントとの差分

同じ変更で直す。

- `03` 4章 #7 PR作成: 出荷前チェックは commit を対象にすること、秘密情報が見つかった・スキャンできない／CI の定義を変えたときは push しないこと、auto-merge は squash、有効にできなければ Draft、PR で Issue を閉じないことを足す
- `03` 4章 #11 レポート: PR を作った時点で PR の本文にまとめレポートを書き、Issue に PR へのリンクを1回コメントすること、CI・マージ・デプロイの結果は後の工程で PR の本文に書き足すことを足す
- `03` 3章: PR を作ったら `pr_opened` を経て `ci_waiting` に進み、起動時の掃除の対象にしないことを足す
- `04` 2章 層6: gitleaks は基準のコミットの設定で呼ぶ（作業ツリーの `.gitleaks.toml`・`.gitleaksignore` を使わない）、インラインの `gitleaks:allow` を見つかったものとして扱う、「走査した commit が1でない」をスキャンできないとして扱うこと、秘密情報・CI の定義の変更は Draft ではなく push しないことを足す
- `04` 2章 実装メモ: 既定の禁止パスに `.gitleaks.toml`・`.gitleaksignore` を足した理由
- `03` 8章: `pipeline/ship.ts`・`pipeline/ship-checks.ts`・`ship-dev.ts` を足す
- constitution の変更は要らない（原則 VI の「1つでも満たさなければ Draft」は、push しない場合を含めて「自動マージしない」側に倒しているので矛盾しない）

## Complexity Tracking

違反なし。
