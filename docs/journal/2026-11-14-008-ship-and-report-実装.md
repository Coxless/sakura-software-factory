# 008 ship-and-report の実装

判定に合格したジョブを PR にする工程を実装し、AI解禁の前の確認用 CLI `pnpm run ship:dev` で本物の GitHub に出荷した。

## gitleaks は `--gitleaks-ignore-path` を渡しても作業ツリーの `.gitleaksignore` を読む

research R4 では「設定と `.gitleaksignore` は基準のコミットのものを一時ディレクトリに置いて渡せば、エージェントが足した許可は効かない」としていた。テスト（同じ commit で `.gitleaks.toml` と `.gitleaksignore` を足す）が `found` ではなく `clean` になった。

切り分け（gitleaks 8.30.1、`--config` は既定の規則だけ、`-i` は空のディレクトリ）:

```
== worktree .gitleaksignore only      （作業ツリーに leak.js:github-pat:1）
INF 1 commits scanned.
INF no leaks found
exit=0
== same, scanning a bare clone        （git clone --bare --no-local した複製）
INF 1 commits scanned.
WRN leaks found: 1
exit=3
```

- gitleaks は、`-i`（`--gitleaks-ignore-path`）とは別に、走査するディレクトリ直下の `.gitleaksignore` を読む
- 作業ディレクトリの bare の複製を走査すれば、作業ツリーがないので読まれない。007 の作業ディレクトリは `--depth 1` の浅い clone だが、そこからの `git clone --bare --no-local` でも `1 commits scanned`・`leaks found: 1` になった
- `.gitleaksignore` は `<file>:<rule>:<line>`（commit を含まない形）でも git モードで効く。基準のコミットの `.gitleaksignore` に従うことのテストに使った

## 本物の GitHub で見つかった不具合2つ

偽の GitHub のテストはすべて通っていたが、`ship:dev` で本物の GitHub に出したら2つ見つかった。

### 1. App の JWT で `/users` を呼べない

```
failed: ship_failed
reason: ship_failed: [@octokit/auth-app] installationId option is required for installation authentication.
```

commit の作成者（App のボット）の ID を引くのに、`app.octokit`（App の JWT）で `GET /users/{slug}[bot]` を呼んでいた。`@octokit/auth-app` は `/app` 系以外の API をインストールの認証で呼ぼうとするので、`installationId` がないと失敗する。`getBotIdentity` に `repo` を渡し、`GET /users` はリポジトリのインストールの認証で呼ぶようにした（`GET /app` は JWT のまま）。

### 2. auto-merge を有効にできず Draft にしたのに、PR の本文が「auto-merge を有効にしました」のまま

PR の本文は PR を作るときに書く。6条件を満たすので auto-merge の文で作り、そのあと auto-merge の有効化に失敗して Draft に変えていた。振り分けが変わったら `PATCH /pulls/{n}` で本文を書き直すようにした（`GitHubPort.updatePullRequestBody`）。Issue の知らせにも「auto-merge を有効にできませんでした」を足した。

GitHub のエラーの文に改行が入っていて（`Request failed due to following response errors:\n - Auto merge is not allowed for this repository`）、本文の振り分けの文が折れたので、改行と連続する空白を1つの空白にまとめる。

## 偽の 005 が onPhase を呼ばないと、PR だけできて状態が進まない

Worker のテストで、合格のジョブが `ci_waiting` にならずに `planning` のまま残った。テストの偽の 005 が `onPhase` を呼ばないので状態が `planning` のまま出荷に進み、PR を作ったあとの `judging → pr_opened → ci_waiting` の遷移が拒否されていた（PR は作られている）。

- 本物の 005 は合格の前に必ず `judging` を通るが、PR だけできて状態が進まないことは避けたい。`shipJob` は push の前に状態が `judging` であることを確かめ、違えば `internal_error` で止める
- Worker は出荷の前に `judging` にそろえる（`testing` からなら進められる。`planning` からは表にないので warn だけ）
- テストの偽の 005 は、本物と同じく `implementing`・`testing`・`judging` の `onPhase` を呼ぶようにした

## 本物の GitHub での確認（quickstart 2章）

`Coxless/factory-sandbox`（public、GitHub Free）。リポジトリの設定は `allow_auto_merge: false`、main のブランチ保護なし、CI なし（運用者の準備の前）。Issue #2（確認用）と #4（`no-auto-merge` ラベル付き）を作って使った。

| # | パッチ・引数 | 結果 | 所要時間 |
|---|---|---|---|
| 1 | README を1行直す、`docs` | `decision: draft`。6条件はすべて ✅ だが auto-merge を有効にできず Draft（PR #5）。理由: `Auto merge is not allowed for this repository` | 11.4 秒 |
| 2 | 同じ、`feature` | `decision: draft`、作業の種類 ❌（PR #6） | 9.9 秒 |
| 3 | 同じ、Issue #4（`no-auto-merge`） | `decision: draft`、`no-auto-merge` ラベル ❌ あり（PR #7） | 9.8 秒 |
| 4 | `pnpm-lock.yaml` にコメントを1行足す | `decision: draft`、禁止パス ❌ `pnpm-lock.yaml`（`**/pnpm-lock.yaml`）（PR #8） | 10.0 秒 |
| 5 | `src/config.js` に本物の形の偽のトークン | `failed: secret_detected`。リモートに作業ブランチがない。Issue に「`src/config.js`:1（github-pat）」とだけ書いた報告 | 5.1 秒 |

- どの PR も作成者は `app/coxless-sakura-factory`、commit の作成者は `coxless-sakura-factory[bot]`
- 所要時間は clone・パッチ・commit・gitleaks・push・PR・Issue へのコメントを含む。SC-005（合格から PR まで 1 分以内）に収まる
- 先に出た不具合のときに作った PR #3（本文が auto-merge のまま）は直す前のもの

## まだ分かっていないこと

- auto-merge が予約される場合（項目1の期待どおりの結果）。`factory-sandbox` で auto-merge を許可し、CI と main のブランチ保護を足してから確かめる
- ブランチ保護がなく auto-merge を許可しただけのときに `enablePullRequestAutoMerge` が返す文（research R6 の想定は「clean status」）
- 無料プランの非公開リポジトリで Draft を作ったときの `422` の文（`DraftUnavailableError` の判定は、`422` かつ本文に `draft` を含むこと）
