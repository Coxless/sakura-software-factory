# Research: ステージングデプロイ（staging-deploy）

spec の Clarifications で決めた方針を、実装の手段に落とした記録。

## R1. push の受付

- **決定**: `push` の知らせを 009 と同じく JSON のあとで分ける。`github/events.ts` の `toPushEvent` で、`ref`・`before`・`after`・`deleted`・`repository.full_name`・`repository.default_branch` だけを TypeBox で取り出す。受付（`http/webhook.ts`）は次の順で絞り、当たったものだけを `deployments` に `queued` で積んで、デプロイの実行器を起こす。GitHub の API は呼ばない
  1. `[staging].repo` が空 → `ignored`（`staging_disabled`）
  2. リポジトリが `[staging].repo` と違う（大文字小文字を区別しない）→ `ignored`（`repo`）
  3. `ref` が `refs/heads/<default_branch>` でない（タグ・ほかのブランチ）→ `ignored`（`ref`）
  4. `deleted` が真・`after` が 0 だけ → `ignored`（`deleted`）
  5. 同じリポジトリの同じ commit の記録がある → `duplicate`
- **理由**: 受付は 007 から「署名 → 絞り込み → SQLite に書く → 202」に統一している。push の結び付け（どのジョブか）には GitHub の API が要るので、受付ではなく実行器で行う（応答を待たせない、SC-003）
- **代わりに考えたもの**: 受付で `GET /commits/{sha}/pulls` を呼んでジョブに結び付ける → 応答が GitHub の遅さに引きずられる。失敗したときに `500` を返すと、GitHub は自動では再送しない

## R2. デプロイの実行器（Worker・CI の見回りと別のループ）

- **決定**: `src/deploy/runner.ts` の `createDeployer`。009 の見回りと同じ形（`start`・`wake`・`stop`）。1周で `queued` の最も古い1件を、即時トランザクションの1文で `running` にして取り出し（`claimNextDeployment`）、最後まで処理してから次を取る。なければ `[worker].poll_interval_seconds` だけ待つ（起こされたらすぐ次）。停止では `AbortController` で実行中の外部コマンド（git・docker）を打ち切る
- **理由**: デプロイは LLM を使わないので、LLM を使う工程の同時実行1件（原則 VII）の外に置ける。Worker が 60 分の実装工程を回している間も、push から 1 分以内に始める（SC-003）。順番どおり1件ずつにするのは、どの commit がいつ出たかを1件ずつ残すため（spec Clarifications）
- **代わりに考えたもの**: Worker の中でデプロイする → 実装工程の間はデプロイが待たされる。待っている push をまとめて最新だけ出す → 飛ばした commit とジョブの結び付けが複雑になる（デモの規模では push は1日に数件）

## R3. ジョブとの結び付け

- **決定**: 実行器が取り出した直後に、`GitHubPort.findMergedPullRequest({ repo, sha })`（`GET /repos/{owner}/{repo}/commits/{sha}/pulls` から、マージ済みで `merge_commit_sha` がその commit の PR の番号）を呼び、同じリポジトリ・同じ PR の番号のジョブを探す
  - ジョブが `ci_waiting` → PR の状態を取り直し（`getPullRequest`）、マージ済みなら 009 の `markMerged`（`ci_waiting` → `merged`、`merged` の記録、PR の本文の CI の欄）を呼んでから進む
  - ジョブが `merged` → `merged` → `deploying`
  - ジョブが終わりの状態など → 状態は変えず、`deployments.job_id` だけ入れる
  - PR が見つからない（人間の直接の push）→ `job_id` は NULL
  - 呼べない（GitHub の障害）→ ジョブなしで続け、`deployments.error` に残す（デプロイ自体は止めない）
- **理由**: auto-merge（squash）のマージ commit が main の push の `after` になる。`merged` への遷移（009 の見回り）と push の知らせのどちらが先に届くかは決まらないので、実行器の側で両方を扱う
- **代わりに考えたもの**: `jobs` にマージ commit の列を足し、009 の見回りで書く → push の方が先に届いたときに結び付かない。push の本文の commit メッセージの `(#12)` を読む → 人間が書き換えられる

## R4. 対象の commit の取得とビルド

- **決定**:
  - 取得: `github/git.ts` の `fetchCommit`。空のディレクトリで `git init` → `git fetch --depth 1 <url> <sha>`（トークンは 007 と同じく環境変数の `http.extraHeader`）→ `git checkout --detach FETCH_HEAD` → `.git` を消す。置き場所は `[storage].work_dir/deploy-<id>`（作業場と同じく、Docker デーモンから見える場所）。終わったら必ず消す
  - ビルド: `docker build --label sakura-factory.staging=1 -t <image_name>:<commit の先頭 12 文字> <dir>`。Dockerfile は対象のリポジトリの直下。時間の上限 `[staging].build_timeout_seconds`
  - docker・compose の子プロセスの環境は `PATH`・`HOME`・`DOCKER_*`・`STAGING_*` だけにする（`extendEnv: false`）。ファクトリーの秘密情報（`SAKURA_AI_API_KEY`・`GITHUB_*`）を、子プロセスにもビルドにもコンテナにも渡さない（SC-007）
- **理由**: GitHub は到達できる commit を SHA で取得できる。浅い取得で十分（ビルドに履歴は要らない）。`.git` を消せば、ビルドの文脈にリモートの情報も入らない
- **代わりに考えたもの**: `git archive --remote` → GitHub は対応していない。ビルドを作業場（`--network none`）で行う → 依存の取得にネットワークが要る。対象のコードは CI を通ってマージされたもので、ビルドは BuildKit のコンテナの中で動き、秘密情報は渡さない

## R5. compose の入れ替え

- **決定**: compose の定義は `deploy/staging/compose.yaml`（ファクトリーのリポジトリに固定。対象のリポジトリのファイルから読まない）。`image: ${STAGING_IMAGE:?}`、ポートは `127.0.0.1:${STAGING_PORT}:3000`。入れ替えは `docker compose -p <project> -f <compose.yaml> up -d --remove-orphans --force-recreate`、止めるのは `down`。隔離は `contracts/staging.md` のとおり（別のネットワーク、`mem_limit`・`cpus`・`pids_limit`、`read_only`、`cap_drop: [ALL]`、`no-new-privileges`、非 root）
- **理由**: `03` 5章（イメージタグを差し替えるだけで切り替え・ロールバックできる）。ポートを `127.0.0.1` にだけ公開するのは 006 の決まり（Docker の公開は ufw を迂回する）
- **代わりに考えたもの**: `docker run` を直接呼ぶ → 隔離の設定とネットワークを自前で管理することになる。compose の `--wait` → イメージの `HEALTHCHECK` の有無に依存する。ヘルスチェックはファクトリーが外から行う（R6）

## R6. ヘルスチェック

- **決定**: `src/deploy/health.ts` の `waitHealthy`。`http://127.0.0.1:<port><health_path>` に `GET` を送り、`200` が `[staging].health_successes` 回（既定 3）続けば通過。間隔は `health_interval_seconds`（既定 2）、1回の要求の上限は 5 秒、全体の上限は `health_timeout_seconds`（既定 60）。結果は「通過・試した回数・最後の状態コードまたはエラー」。`fetch` は差し替えられる（テスト）
- **理由**: `03` 5章「`/healthz` を数回確認」。起動の途中（接続の拒否）を失敗と数えないために、全体の時間の中で「続けて N 回」を待つ。1回だけ通ってすぐ落ちるアプリを通さない（spec Edge Cases）
- **代わりに考えたもの**: Docker の `HEALTHCHECK` → デモアプリの Dockerfile に依存し、ファクトリーから結果を読むのに手間がかかる

## R7. ロールバック

- **決定**: 入れ替えの失敗（`up` が失敗）とヘルスチェックの失敗で行う。戻し先は、同じリポジトリの `succeeded` のデプロイのうち最も新しいもの（今のデプロイを除く）。そのイメージが手元にあれば（`docker image inspect`）`up` して、もう一度ヘルスチェックする。なければ・戻し先がなければ `down` でステージングを止める。記録: `rolled_back = 1`、`rolled_back_to`（止めたなら NULL）、`rollback_healthy`（戻した版のヘルスチェックの結果。止めたなら NULL）
- **理由**: `04` 層9・原則 VI。直前の「成功した」版に戻す（直前のデプロイが失敗していたら、その前の成功した版がステージングで動いている版）
- **代わりに考えたもの**: compose の前の状態を覚えておく → ファクトリーが再起動すると失われる。記録（`deployments`）から決めれば再起動をまたいでも同じ

## R8. revert PR

- **決定**: `github/git.ts` の `revertRange`。既定のブランチを履歴ごと取得し（`cloneBranchForRetry` と同じく `--single-branch`、深さの制限なし）、`git merge-base --is-ancestor <before> <after>` と `<after>` が既定のブランチの履歴にあることを確かめてから、`git revert --no-commit <before>..<after>` を既定のブランチの先頭に当てる。衝突したら `git revert --abort` して作らない。当たったら 008 の `commitForJob`（App のボットの名前、フックを使わない）で1つの commit にし、`factory/revert-<after の先頭 7 文字>` に push（強制しない）。PR は `createPullRequest`（`draft: false`、auto-merge は有効にしない）。題は `Revert <after の先頭 7 文字>（ステージングのヘルスチェックの失敗）`
  - 作らない場合: `before` が 0 だけ（ブランチの作成）・`before` がない（起動時の取り直しで、前のデプロイの記録がない）・祖先でない（強制の push）・衝突・変更が空（すでに戻されている）。理由を `deployments.error` とレポートに書く
- **理由**: 原則 VI の MUST。revert PR は検査役の判定を通っていないので、自動マージの6条件（`verdict`）を満たさない。人間がマージする（spec Clarifications）。範囲全体を1つの commit にするのは、人間がまとめて push した場合も1つの PR で戻せるようにするため
- **代わりに考えたもの**: `git revert -m 1`（マージ commit）→ auto-merge は squash なので不要。人間のマージ commit を含む範囲は `--no-commit` の範囲の revert で扱える（マージ commit を含むと失敗する → 作らない）

## R9. ビルドの失敗・中断・取りこぼし

- **決定**:
  - 取得・ビルドの失敗 → `failed`（`failed_stage` = `fetch`・`build`）。ステージングは触らない。ジョブは 007 の `failJob`（理由 `deploy_failed`）
  - 起動時（`recoverDeployments`）: `running` のデプロイを `failed`（`interrupted`）にし、結び付いた `deploying` のジョブを `failJob(restarted)`。デプロイの作業ディレクトリ（`deploy-*`）を消す。`queued` は残す
  - 起動時の取り直し（`catchUpDeployments`）: `[staging].repo` があれば、`getDefaultBranchHead` で既定のブランチの先頭を取り、記録にない commit なら積む（`before_sha` は最後に記録したデプロイの commit）。失敗はログだけ。起動を止めない
  - 停止の合図: 実行中なら打ち切り、`failed`（`interrupted`）にし、ジョブを `failJob(stopped)`
- **理由**: 原則 II（すべての待ちに上限、失敗時も報告）。007 の起動時の掃除と同じ考え方（途中のものを無理に続けない）。GitHub は失敗した配送を自動では再送しないので、取りこぼしは起動時に拾う
- **代わりに考えたもの**: 途中のデプロイを起動時にやり直す → 再起動の原因がデプロイ自体だと繰り返す

## R10. 失敗の報告と PR の本文

- **決定**:
  - `failJob` の分類に `deploy_failed` を足す。PR がマージ済みのジョブ（`merged`・`deploying` から失敗したもの）は、009 の「Draft に変えて人間に渡す」を行わない（マージ済みの PR は Draft にできない）
  - ロールバックしたジョブは `failed` ではなく `rolled_back`（終わりの状態）にし、Issue に「ステージングから戻しました」を1回投稿する（`report_posted` の記録で二重にしない）
  - PR の本文に、CI の欄の後ろにデプロイの欄（`<!-- factory:deploy -->`〜`<!-- /factory:deploy -->`）を書き足す。欄は `deployments` のそのジョブの行から作り直す（009 の CI の欄と同じ作り方）
- **理由**: 原則 II（失敗時も Issue に1回報告）と 01 の工程レポート（デプロイ結果を含める）。Issue は閉じない（人間がステージングで確かめる、spec Clarifications）

## R11. イメージの片付け

- **決定**: 成功したデプロイのあと、`deployments` の `image_tag` のうち、新しい順に `succeeded` の `[staging].keep_images` 件（既定 5）と、今のデプロイ・戻し先に当たるもの以外を `docker image rm` する（なければ無視）。失敗は記録だけ
- **理由**: VPS のディスクを守る。何を消すかを記録から決めれば、ファクトリーが作っていないイメージに触れない

## R12. 記録（`deployments` の列）

- **決定**: マイグレーション `0005_staging_deploy.sql`。001 の `deployments` に列を足し、状態に `queued` を足す。`deployments` はまだ1行も書かれていないので、Drizzle の作り直し（新しい表に写して入れ替え）で CHECK と一意の制約を変える
  - 足す列: `repo`（NOT NULL）、`before_sha`、`failed_stage`（`fetch`・`build`・`release`・`health`・`interrupted`）、`rollback_healthy`、`revert_pr_number`、`error`（伏せ字済み）、`started_at`
  - 一意: `(repo, commit_sha)`（同じ commit を2回デプロイしない、FR-003）
  - 索引: `(status, id)`（取り出し）、`job_id`
- **理由**: デプロイの成功率・ロールバックの回数・ジョブごとの結果を SQL だけで集計する（SC-006、011 の `/status`）

## R13. 設定 `[staging]`

- **決定**: [contracts/factory-toml.md](./contracts/factory-toml.md)。`repo` が空ならデプロイの機能は止まっている。compose の定義の場所は設定にしない（ファクトリーのコードの一部）
- **理由**: VPS とローカルの予行演習・本物の Docker のテストで、同じコードを設定だけで切り替える。compose の定義を設定にすると、設定ファイル（`/etc`）からファクトリーのコードの外のファイルを読ませることになる

## R14. デモ用の対象リポジトリ

- **決定**: `Coxless/factory-sandbox` に、`src/server.js`（`node:http`。`PORT` で待ち受け、`/healthz` で `200`）、`Dockerfile`（`node:24-slim`、依存なし、`USER node`、`EXPOSE 3000`）、`.dockerignore`、`.github/workflows/ci.yml`（Node 24・corepack・`pnpm install --frozen-lockfile`・`pnpm run check`、ジョブ名 `check`）、AGENTS.md（ステージングの約束）を足す。main のブランチ保護で `check` を必須にし、リポジトリの設定で auto-merge と squash を許す（`gh api`）
- **理由**: `03` 5章「対象リポジトリの設定」。依存を持たないので、作業場（ネットワークなし）でもビルドでも速い

## R15. テスト

- **決定**:
  - 単体: 偽の `StagingRuntime`（ビルド・入れ替え・ヘルスチェック・イメージの有無を決められる）、偽の GitHub、ローカルの bare リポジトリ（取得・revert の push）で、受付・取り出し・結び付け・成功・ロールバック・revert PR・ビルドの失敗・起動時の掃除と取り直し・停止を確かめる
  - 本物の Docker: `src/deploy/staging.docker.test.ts`。`FROM factory-sandbox:latest` の小さなアプリ（環境変数で `/healthz` の状態を変える）を2つビルドし、別の compose のプロジェクトとポート（3199）で、入れ替え・ヘルスチェック・ロールバックを確かめる。Docker・作業場のイメージ・`docker compose` がなければ理由を出して飛ばす（CI では `FACTORY_SANDBOX_REQUIRED=1` で飛ばさない）
  - Workshop に `docker-compose-v2` を足す（`setup-base`）。CI のランナー（ubuntu-24.04）と VPS（006 の `setup.sh`）には入っている
- **理由**: 原則 開発ワークフロー（テストで GitHub を呼ばない）。作業場のイメージを土台にすれば、Docker Hub から取らずにビルドできる
