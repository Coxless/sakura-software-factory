# Contract: 配備スクリプト（006）

どちらも root で実行する。運用者は最初にリポジトリを `/opt/sakura-factory/app` に clone し、そこの `deploy/scripts/setup.sh` を流す（予行演習は bundle から同じ場所に clone する）。`set -euo pipefail`。各手順は `step "<名前>"` で名前を出してから実行し、失敗したら `ERROR: <名前> で失敗しました` を出して終了コード 1 で止まる（FR-023）。

## `deploy/scripts/setup.sh`（初回の配備。何度流してもよい）

入力（環境変数）:

| 変数 | 既定 | 説明 |
|---|---|---|
| `FACTORY_REPO_URL` | `https://github.com/Coxless/sakura-software-factory.git` | 取得元。予行演習では `git bundle` のパス |
| `FACTORY_REF` | `origin/main` | チェックアウトするコミットかタグ |

手順（この順。手順書の見出しと同じ名前）:

| # | 手順 | 内容 | 2回目 |
|---|---|---|---|
| 1 | パッケージ | `apt-get install` ca-certificates curl git ripgrep sqlite3 docker.io docker-compose-v2 ufw shellcheck debian-keyring debian-archive-keyring apt-transport-https | 入っていれば何もしない |
| 2 | Node.js | `v24.22.2` の tarball を `SHASUMS256.txt` で確かめて `/opt/node-v24.22.2` に展開、`/opt/node` をリンクに。`corepack enable` | 同じ版があれば飛ばす |
| 3 | gitleaks | `scripts/install-gitleaks.sh` | 同じ版があれば飛ばす |
| 4 | Caddy | 公式の apt リポジトリと鍵を足し、`caddy=2.11.9` を入れて `apt-mark hold` | 同じ版なら飛ばす |
| 5 | ユーザーとディレクトリ | `factory` システムユーザー（`docker` グループ）、`/etc/sakura-factory`、`/opt/sakura-factory` | あれば作らない |
| 6 | コードの取得 | `/opt/sakura-factory/app` がなければ `FACTORY_REPO_URL` から `git clone`（手順書どおりなら既にあるので何もしない。版の切り替えは update.sh） | 何もしない |
| 7 | 設定と秘密情報 | `/etc/sakura-factory/factory.toml` がなければ作る（[factory-toml.md](./factory-toml.md)）。`factory.env` と `/etc/caddy/caddy.env` がなければ、ひな形を写して**止まる**（運用者が値を書いてから流し直す）。あれば所有者と権限（`0640`）を確かめ、違えば止まる | 上書きしない |
| 8 | systemd と Caddy | `factory.service`・Caddy の drop-in・`Caddyfile` を写し、`daemon-reload`、`caddy validate`、`systemctl enable factory caddy docker` | 写し直すだけ |
| 9 | ファイアウォールと SSH | ufw: 受信は既定で拒否、22・80・443 を許可して有効化。SSH: 鍵が1つ以上あるのを確かめてから `sshd_config.d/01-sakura-factory.conf` でパスワードでのログインを無効にし、`sshd -t` と `sshd -T`（実際に効く値）を確かめたあと reload | 同じ設定のまま |
| 10 | 更新 | `update.sh "$FACTORY_REF"` を呼ぶ | 同じ版なら依存とイメージは変わらない |

- 予行演習でだけ、`FACTORY_SKIP_SSH=1` で手順9の SSH の部分を飛ばせる（コンテナに SSH の鍵がないため）。ファイアウォールは飛ばさない
- データベース（`/var/lib/sakura-factory`）には触らない（FR-022、SC-002）

## `deploy/scripts/update.sh [ref]`

| # | 手順 | 内容 |
|---|---|---|
| 1 | 取得 | `git -C /opt/sakura-factory/app fetch --tags origin` |
| 2 | チェックアウト | `git checkout --detach <ref>`（既定 `origin/main`） |
| 3 | 依存 | `pnpm install --frozen-lockfile --prod` |
| 4 | 作業場のイメージ | `docker build -t factory-sandbox:latest sandbox` |
| 5 | マイグレーション | `runuser -u factory -- env FACTORY_CONFIG=... /opt/node/bin/node src/migrate.ts` |
| 6 | 再起動 | `systemctl restart factory` |
| 7 | 生存確認 | `curl -fsS http://127.0.0.1:8787/healthz` を 1 秒おきに 30 秒まで。通らなければ `journalctl -u factory -n 50` を出して失敗 |
| 8 | 版の表示 | `deployed <コミット> (<ref>)` を出す |

- 動いている版は `git -C /opt/sakura-factory/app rev-parse HEAD` でも確かめられる（FR-021）

## ひな形

- `deploy/factory.env.example`: `SAKURA_AI_API_KEY=`（空）。007 で足す GitHub App の変数はコメントで場所だけ示す
- `deploy/caddy.env.example`: `FACTORY_DOMAIN=`・`STAGING_DOMAIN=`・`CADDY_TLS=`（空）

## 手順書（`deploy/README.md`）

1. 事前の確認（VPS の契約と OS、DNS が VPS を向いていること〔`dig +short`〕、さくらのパケットフィルターで 22/80/443、SSH の鍵）
2. リポジトリを `/opt/sakura-factory/app` に clone し、`/opt/sakura-factory/app/deploy/scripts/setup.sh` の1回目を流す（ひな形が置かれて止まる）
3. `factory.env`・`caddy.env` に値を書く（権限の確かめ方）
4. `setup.sh` の2回目
5. 確かめ方（`systemctl status`、`curl https://$FACTORY_DOMAIN/healthz`、`journalctl -u factory -o cat`、`ufw status`、外からの `nc -zv <ip> 8787` が届かないこと）
6. 更新（`update.sh <ref>`）
7. 困ったとき（証明書の取得の失敗、再起動の上限に達した、ロールバックは `update.sh <前のコミット>`）

各手順に「期待する出力」を書く（FR-020）。
