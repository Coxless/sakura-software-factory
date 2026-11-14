# 010 staging-deploy の実装

## Workshop に docker compose がなかった

`workshop exec dev -- docker compose version` が次で失敗した。

```
docker: unknown command: docker compose
```

`setup-base` は `docker.io` だけを入れていた。Ubuntu の `docker-compose-v2` を足して `workshop refresh dev` したら `Docker Compose version 2.40.3+ds1-0ubuntu1~24.04.1` になった。VPS（006 の `setup.sh`）と CI のランナー（ubuntu-24.04）には最初から入っている。

## drizzle-kit generate が、また存在しない列を二重引用符で SELECT した

009 の `jobs` と同じ現象（`docs/journal/2026-11-14-009-ci-feedback-実装.md`）。`deployments` を作り直す SQL の `INSERT ... SELECT` に、元の表にない `"repo"`・`"before_sha"` などが二重引用符で並んでいた。SQLite は解決できない二重引用符の識別子を文字列として扱うので、エラーにならずに `'repo'` という値が入る。

今回は CHECK と一意の制約を変えるので作り直しが要る。`INSERT` を元の表にある列だけを写す形に手で書き直した（`repo` は `''`、`failed` の行の `failed_stage` は `interrupted`、`rolled_back = 0` の行の `rolled_back_to` は NULL）。

0000〜0004 を流した DB に、旧い形の `deployments` を2行（`failed`・ロールバックあり／`succeeded`）入れてから 0005 を流し、行が残ること・新しい CHECK に通ること・索引が3つできることを確かめた。

## file:// の bare リポジトリから SHA を指定して取得できた

`fetchCommit` は `git init` → `git fetch --depth 1 <url> <sha>` → `checkout --detach FETCH_HEAD`。GitHub は到達できる commit を SHA で取れるが、ローカルの bare リポジトリ（テスト）で `uploadpack.allowReachableSHA1InWant` を設定せずに通るかは分からなかった。git 2.43.0 では設定なしで通った（プロトコル v2 の既定の動き）。本物の GitHub とインストールトークンでの取得は、まだ確かめていない。

## Workshop の docker build は旧いビルダー

本物の Docker のテストで、ビルドの失敗（`RUN exit 3`）の終了コードが 1 だと思って正規表現を書いたら、実際は 3 だった。

```
イメージのビルド（終了コード 3）: DEPRECATED: The legacy builder is deprecated and will be removed in a future release. ...
```

Ubuntu の `docker.io` には buildx が入っておらず、`docker build` は旧いビルダーで動く。旧いビルダーは `RUN` の終了コードをそのまま返す。テストは `終了コード \d+` に直した。VPS も同じ `docker.io` なので、同じ警告が出る（動作には問題ない）。

## 本物の Docker のテストの時間

作業場のイメージ（`factory-sandbox:latest`）を土台に、`/healthz` が 200 と 500 を返すアプリを2つビルドし、プロジェクト `sakura-staging-test`・ポート 3199 で 200 → 500 → 200 と入れ替えた。不健康な版のヘルスチェックは全体の上限まで待つので、上限 30 秒で 64 秒、10 秒で 36 秒かかった。テストは 10 秒にした。

コンテナの隔離は `docker inspect` で確かめた: `65534:65534 true 127.0.0.1`（ユーザー・読み取り専用のルート・公開のアドレス）。

なお、Workshop には作業場のイメージがなかったので、これまで `*.docker.test.ts` は手元では飛ばされていた（CI では `FACTORY_SANDBOX_REQUIRED=1` で必ず回る）。`pnpm run sandbox:build` で作ってから全体を流した: 66 ファイル・1162 件が通過、6 件は飛ばした理由を出すだけのテスト。

## テストの台本の誤り

「同じジョブを2回ロールバックしても Issue への報告は1回」のテストで、偽のヘルスチェックの結果を `[失敗, 成功]`（尽きたら最後を繰り返す）にしていたため、2回目のデプロイが成功して `deployed` になった。`[失敗, 成功, 失敗, 成功]` に直した。最初は2回目の commit を存在しない SHA にしていて、PR に結び付かずにテストが空振りしていたので、bare リポジトリに本物の commit を積んで PR のマージ commit を差し替える形にした。

## デモ用のリポジトリ（Coxless/factory-sandbox）

- PR #9（`staging-app`）: `src/server.js`（依存なし、`GET /healthz` → 200）、`src/server.test.js`、`Dockerfile`（`node:24-slim`、`USER node`）、`.dockerignore`、`.github/workflows/ci.yml`（ジョブ `check`: `pnpm install --frozen-lockfile` → `pnpm run check` → `docker build`）、AGENTS.md にステージングの約束
- CI の `check` は 12 秒で通過。squash でマージ（`cdc7a2c`）
- 作業場のイメージで `--network none` のまま `pnpm run check` が通る（5 件）。Workshop で `docker build` → compose で起動 → `/healthz` が `{"status":"ok"}`、`/` が 200
- `gh api` で設定した値:

```
PATCH repos/Coxless/factory-sandbox → {"allow_auto_merge":true,"allow_squash_merge":true,"delete_branch_on_merge":true,...}
PUT   repos/Coxless/factory-sandbox/branches/main/protection → {"checks":["check"],"strict":false,"admins":false,"reviews":null}
```

merge commit・rebase も許したまま（人間が使うかもしれない）。ファクトリーの auto-merge は squash を指定する。

## まだ分かっていないこと

- 本物の GitHub での通し（App の `push` の配送 → デプロイ → PR の本文）。Workshop で smee を使って確かめる（quickstart 3章）。App の「Subscribe to events」に Push が入っているかも確かめる
- VPS の systemd の保護設定（`ProtectSystem=strict`）の中で、`docker compose` が `$HOME/.docker` に書こうとして失敗しないか（`HOME` は `/var/lib/sakura-factory`）。予行演習（`pnpm run deploy:rehearsal`）にステージングの項目はまだない
