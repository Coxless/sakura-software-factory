# Contract: ステージングの compose とデモアプリの約束（010）

## 1. `deploy/staging/compose.yaml`

ファクトリーのリポジトリに置く（対象のリポジトリのファイルから読まない）。ファクトリーは次の環境変数だけを渡して `docker compose -p <[staging].project> -f deploy/staging/compose.yaml` を呼ぶ。

| 変数 | 値 |
|---|---|
| `STAGING_IMAGE` | `<[staging].image_name>:<commit の先頭 12 文字>` |
| `STAGING_PORT` | `[staging].port` |

| 項目 | 値 | 理由 |
|---|---|---|
| `image` | `${STAGING_IMAGE:?}` | イメージを差し替えるだけで入れ替え・ロールバックする（`03` 5章） |
| `ports` | `127.0.0.1:${STAGING_PORT:?}:3000` | ループバックにだけ公開し、Caddy が転送する（006。Docker の公開は ufw を迂回する） |
| `environment` | `PORT=3000`、`NODE_ENV=production` だけ | ファクトリーの秘密情報を渡さない |
| `networks` | このプロジェクトだけのネットワーク | factory と別のネットワーク（`04` 層9） |
| `user` | `65534:65534` | 非 root |
| `read_only` | `true`（`/tmp` は tmpfs） | 書き換えられない |
| `cap_drop` | `[ALL]` | |
| `security_opt` | `no-new-privileges:true` | |
| `mem_limit`・`memswap_limit` / `cpus` / `pids_limit` | `256m` / `0.5` / `128` | factory に影響しない（`04` 層9） |
| `restart` | `unless-stopped` | VPS の再起動のあとも、最後に入れ替えた版が動く |
| `logging` | `json-file`、`max-size: 10m`、`max-file: 3` | ディスクを守る |
| `labels` | `sakura-factory.staging=1` | |

- 入れ替え: `up -d --remove-orphans --force-recreate`。止める: `down --remove-orphans`
- `docker` と `docker compose` の子プロセスの環境は `PATH`・`HOME`・`DOCKER_*`（あれば）と上の2つだけ（research R4）

## 2. デモアプリ（対象のリポジトリ）の約束

対象のリポジトリの AGENTS.md に書く。

- リポジトリの直下に `Dockerfile` があり、追加の引数なしで `docker build` できる
- コンテナの中で `PORT`（3000）で待ち受ける
- `GET /healthz` が正常なら `200` を返す
- 読み取り専用のルート・非 root（`65534`）・`/tmp` だけ書き込める状態で動く
- 起動は `[staging].health_timeout_seconds`（60 秒）より十分に短い
