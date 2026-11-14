# Quickstart: ステージングデプロイ（010）

## 1. 自動テスト（GitHub・LLM を使わない）

```bash
workshop exec dev -- bash -lc 'cd /project && pnpm run check'
```

- 受付（`push`）・取り出し・結び付け・成功・ロールバック・revert PR（ローカルの bare リポジトリ）・ビルドの失敗・起動時の掃除と取り直し・停止は、偽の `StagingRuntime` と偽の GitHub で確かめる
- `src/deploy/staging.docker.test.ts` は本物の Docker と `docker compose` を使う。作業場のイメージ（`pnpm run sandbox:build`）を土台に小さなアプリを2つビルドし、プロジェクト `sakura-staging-test`・ポート 3199 で、入れ替え・ヘルスチェック・ロールバックを確かめる。Docker・イメージ・compose がなければ理由を出して飛ばす（CI では `FACTORY_SANDBOX_REQUIRED=1` で飛ばさない）

## 2. Workshop でステージングを手で動かす

Workshop に `docker compose` が要る（`setup-base` で `docker-compose-v2` を入れる。定義を変えたら `workshop refresh dev`）。

```bash
# デモ用のリポジトリをビルドして compose で起動する
workshop exec dev -- bash -lc '
  set -e
  dir=$(mktemp -d) && git clone --depth 1 https://github.com/Coxless/factory-sandbox "$dir"
  docker build -t sakura-staging-app:manual "$dir"
  cd /project && STAGING_IMAGE=sakura-staging-app:manual STAGING_PORT=3100 \
    docker compose -p sakura-staging -f deploy/staging/compose.yaml up -d
  sleep 2 && curl -fsS http://127.0.0.1:3100/healthz
  docker compose -p sakura-staging -f deploy/staging/compose.yaml down
'
```

期待: `/healthz` が `200` を返す。

## 3. 本物の GitHub で通す（運用者が行う）

前提: 007 の quickstart 3章のとおり、App の Webhook を smee で Workshop に転送している。App の設定で `push` のイベントを購読する。

1. `factory.toml` の `[staging].repo` を `Coxless/factory-sandbox` にしてファクトリーを起動する
2. デモ用のリポジトリの main に、小さな変更を PR でマージする（または `@agent` の依頼を流す）
3. 期待: `deployments` に `succeeded` の行、`curl http://127.0.0.1:3100/healthz` が `200`。ファクトリーのジョブなら PR の本文にステージングの欄
4. `/healthz` が `500` を返す変更をマージする
5. 期待: 直前のイメージに戻り（`docker compose -p sakura-staging ps` のイメージ）、revert PR が作られる。ファクトリーのジョブなら `rolled_back` になり Issue に報告

```bash
sqlite3 data/factory.db "SELECT id, commit_sha, status, failed_stage, rolled_back, rolled_back_to, revert_pr_number FROM deployments ORDER BY id"
```
