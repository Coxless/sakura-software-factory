# VPS 配備の手順書

さくらのVPS（Ubuntu 24.04 LTS）にファクトリーを配備する手順。VPS解禁の日（2026-12-03）は、この手順を上から流すだけにする。

この構成では、LLM の推論は さくらのAI Engine（ZDR）だけで行い、推論を国産・ZDRで閉じる。VPS はファクトリー本体・作業場（ジョブごとの Docker コンテナ）・ステージングを1台で動かし、Caddy で HTTPS を受ける。リポジトリは GitHub のまま。

- 仕様: `specs/006-vps-ops/`（配置は `contracts/deploy.md`、Caddy は `contracts/caddy.md`、systemd は `contracts/systemd.md`）
- 事前の予行演習: `pnpm run deploy:rehearsal`（ローカルの Docker で同じスクリプトを流す。`specs/006-vps-ops/quickstart.md` 4章）
- ドメインは例として `factory.example.jp`・`staging.example.jp` と書く。実際の値はリポジトリに書かない

## 1. 事前の確認

| 確認すること                 | 確かめ方                                                                    | 期待する結果                                                  |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| OS                           | `lsb_release -ds`                                                           | `Ubuntu 24.04.x LTS`                                          |
| SSH の鍵でログインできる     | 手元から `ssh <user>@<VPS の IP>`                                           | パスワードを聞かれずに入れる                                  |
| DNS が VPS を向いている      | 手元から `dig +short factory.example.jp` と `dig +short staging.example.jp` | どちらも VPS の IP                                            |
| さくらのパケットフィルター   | コントロールパネルの「パケットフィルター」                                  | 22・80・443（TCP）だけを許可                                  |
| さくらのAI Engine の APIキー | コントロールパネル                                                          | 手元に控えてある（チャットやリポジトリに貼らない）            |
| GitHub App                   | 3章の「GitHub App を作る」                                                  | App の ID・秘密鍵（.pem）・Webhook のシークレットが手元にある |

DNS が VPS を向いていないと、Caddy の証明書の取得が失敗する（7章）。

## 2. リポジトリの取得と setup.sh の1回目

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/Coxless/sakura-software-factory.git /opt/sakura-factory/app
sudo /opt/sakura-factory/app/deploy/scripts/setup.sh
```

期待する出力（最後）:

```
==> 設定と秘密情報
ERROR: 設定と秘密情報 で失敗しました: /etc/sakura-factory/factory.env を作りました。値を書いてから setup.sh を流し直してください
```

ここまでで、パッケージ・Node.js・gitleaks・Caddy・`factory` ユーザーが入っている。止まるのは、秘密情報のひな形を置いたため（想定どおり）。

## 3. 秘密情報とドメインを書く

### GitHub App を作る（初回だけ。007）

GitHub の Settings → Developer settings → GitHub Apps → New GitHub App で作る。仕様: `specs/007-github-intake/contracts/github-app.md`

| 項目                                    | 値                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook URL                             | `https://factory.example.jp/webhook`                                                                                                                                  |
| Webhook secret                          | `openssl rand -hex 32` の出力（`GITHUB_WEBHOOK_SECRET` と同じ値）                                                                                                     |
| Repository permissions                  | Issues: Read and write、Pull requests: Read and write、Contents: Read and write、Checks: Read-only、Actions: Read-only、Metadata: Read-only。**Workflows は与えない** |
| Subscribe to events                     | Issue comment、Check suite、Pull request、Push                                                                                                                        |
| Where can this GitHub App be installed? | Only on this account                                                                                                                                                  |

作ったら、App の ID を控え、「Generate a private key」で秘密鍵（.pem）を作り、対象のリポジトリに App を入れる（Install App）。秘密鍵は VPS にだけ置く:

```bash
# 手元から（.pem はチャットやリポジトリに置かない）
scp ./factory-app.private-key.pem <user>@<VPS の IP>:/tmp/github-app.pem
# VPS で
sudo install -o root -g factory -m 0640 /tmp/github-app.pem /etc/sakura-factory/github-app.pem
shred -u /tmp/github-app.pem
```

### 秘密情報を書く

```bash
sudoedit /etc/sakura-factory/factory.env   # SAKURA_AI_API_KEY・GITHUB_APP_ID・GITHUB_APP_PRIVATE_KEY_PATH・GITHUB_WEBHOOK_SECRET
sudo /opt/sakura-factory/app/deploy/scripts/setup.sh   # 今度は caddy.env のひな形を置いて止まる
sudoedit /etc/caddy/caddy.env              # FACTORY_DOMAIN・STAGING_DOMAIN・CADDY_TLS（メールアドレス）・STATUS_USER・STATUS_PASSWORD_HASH
```

`STATUS_USER`・`STATUS_PASSWORD_HASH` は状況ページ（`/status`）の Basic 認証（011）。ハッシュは VPS で作る（Caddy は1つ目の setup.sh で入っている）:

```bash
caddy hash-password   # パスワードを2回入れる。出力（$2a$14$...）をコピーする
```

`caddy.env` には、出力を**単一引用符で囲んで**書く（`setup.sh` が `source` で読むので、囲まないと `$` が展開されて壊れる）。パスワードの平文はどこにも書かない。

```
STATUS_USER=<好きな名前>
STATUS_PASSWORD_HASH='$2a$14$...'
```

2つのどちらかが空なら `setup.sh` は止まる（認証なしで `/status` を公開する設定は作らない）。

確かめ方:

```bash
sudo stat -c '%U:%G %a %n' /etc/sakura-factory/factory.env /etc/sakura-factory/github-app.pem /etc/caddy/caddy.env
```

期待する出力:

```
root:factory 640 /etc/sakura-factory/factory.env
root:factory 640 /etc/sakura-factory/github-app.pem
root:caddy 640 /etc/caddy/caddy.env
```

## 4. setup.sh の2回目

```bash
sudo /opt/sakura-factory/app/deploy/scripts/setup.sh
```

手順の見出し（`==> パッケージ` → `Node.js` → `gitleaks` → `Caddy` → `ユーザーとディレクトリ` → `コードの取得` → `設定と秘密情報` → `systemd と Caddy` → `ファイアウォールと SSH` → `更新`）が順に出て、最後に次が出る:

```
==> 版の表示
deployed <コミット> (origin/main)
```

途中で止まったら `ERROR: <手順> で失敗しました` の手順を直してから、もう一度流す（何度流しても同じ結果になる。データベースは消えない）。

## 5. 確かめ方

| 確認                                 | コマンド                                                                                      | 期待する結果                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| サービス                             | `systemctl is-active factory caddy docker`                                                    | 3行とも `active`                                                                                    |
| 生存確認（外から）                   | 手元から `curl -s https://factory.example.jp/healthz`                                         | `{"status":"ok"}`                                                                                   |
| 公開していないパス                   | 手元から `curl -s -o /dev/null -w '%{http_code}\n' https://factory.example.jp/`               | `404`                                                                                               |
| 状況ページ（認証なし）               | 手元から `curl -s -o /dev/null -w '%{http_code}\n' https://factory.example.jp/status`         | `401`                                                                                               |
| 状況ページ（認証あり）               | 手元から `curl -s -u <STATUS_USER> 'https://factory.example.jp/status?format=json' \| jq .consumption` | 今月の消費（パスワードを聞かれる）。ブラウザで開くと5つの数値の画面                                 |
| HTTP から HTTPS へ                   | 手元から `curl -sI http://factory.example.jp/healthz`                                         | `308` と `Location: https://...`                                                                    |
| ログ                                 | `journalctl -u factory -o cat -n 5`                                                           | JSON の行（`"msg":"factory started"` を含む）                                                       |
| ファイアウォール                     | `sudo ufw status`                                                                             | `22/tcp`・`80/tcp`・`443/tcp` だけ `ALLOW`                                                          |
| SSH はパスワードで入れない           | `sudo sshd -T \| grep -E '^(passwordauthentication\|permitrootlogin) '`                       | `passwordauthentication no` と `permitrootlogin without-password`（版によって `prohibit-password`） |
| ファクトリーのポートが外から届かない | 手元から `nc -zv -w 3 <VPS の IP> 8787`                                                       | 届かない（タイムアウトか拒否）                                                                      |
| 動いている版                         | `git -C /opt/sakura-factory/app rev-parse HEAD`                                               | 4章の `deployed` のコミット                                                                         |
| gitleaks                             | `gitleaks version`                                                                            | `8.30.1`                                                                                            |
| 自動の再起動                         | `sudo systemctl kill -s KILL factory`、30 秒後に `curl -s https://factory.example.jp/healthz` | `{"status":"ok"}`                                                                                   |

ステージング（`https://staging.example.jp`）は、デプロイが一度も成功していないあいだは `502` を返す（想定どおり）。

### ステージング（010）

ファクトリーは `/etc/sakura-factory/factory.toml` の `[staging].repo`（既定 `Coxless/factory-sandbox`）の main への push を受けて、デモアプリをビルドし `docker compose` で入れ替える。仕様: `specs/010-staging-deploy/`

- 初回: `[staging].public_url` に `https://staging.example.jp` を書いて `sudo systemctl restart factory`。起動時に main の先頭がデプロイに積まれる（停止中の push の取りこぼしも同じ仕組みで拾う）
- App の「Subscribe to events」に `Push` が入っていること（上の表）

| 確認                   | コマンド                                                                                                                                                                                        | 期待する結果                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 動いている版           | `sudo -u factory docker compose -p sakura-staging ps --format '{{.Image}} {{.Status}}'`                                                                                                         | `sakura-staging-app:<commit の先頭 12 文字> Up …` |
| 外から                 | 手元から `curl -s https://staging.example.jp/healthz`                                                                                                                                           | `{"status":"ok"}`                                 |
| ループバックだけに公開 | `sudo ss -ltnp \| grep 3100`                                                                                                                                                                    | `127.0.0.1:3100` だけ                             |
| デプロイの記録         | `sqlite3 /var/lib/sakura-factory/factory.db "SELECT id, substr(commit_sha,1,7), status, failed_stage, rolled_back, rolled_back_to, revert_pr_number FROM deployments ORDER BY id DESC LIMIT 5"` | 最新が `succeeded`                                |

ヘルスチェックに失敗すると、ファクトリーは直前に成功したイメージに戻して revert PR を作る（auto-merge は有効にしない）。revert PR を確かめてからマージすると、その push もデプロイされる。

## 6. 更新

```bash
sudo /opt/sakura-factory/app/deploy/scripts/update.sh            # origin/main の最新
sudo /opt/sakura-factory/app/deploy/scripts/update.sh v0.2.0     # タグかコミットを指定
```

期待する出力（最後）: `deployed <コミット> (<指定した ref>)`。取得 → チェックアウト → 依存 → 作業場のイメージ → マイグレーション → 再起動 → 生存確認の順に進む。

`/etc/sakura-factory/factory.toml` は初回にしか作らない。リポジトリの `factory.toml` に項目が増えたら、差を見て手で足す:

```bash
diff /opt/sakura-factory/app/factory.toml /etc/sakura-factory/factory.toml
```

（`[storage]` の3行〔`database_path`・`trace_dir`・`work_dir`〕と `[staging].public_url` だけが違うのが正しい状態）

## 7. 困ったとき

| 症状                         | 確かめ方                                                                                           | 対処                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS がつながらない         | `journalctl -u caddy -n 50 --no-pager` に `obtaining certificate` の失敗                           | DNS（1章）とパケットフィルターの 80・443 を確かめ、`sudo systemctl restart caddy`                                                                                               |
| `factory` が止まったまま     | `systemctl status factory` に `start request repeated too quickly`                                 | `journalctl -u factory -n 100 -o cat` で原因を直し、`sudo systemctl reset-failed factory && sudo systemctl start factory`                                                       |
| 更新した版で動かない         | `update.sh` が「生存確認」で失敗                                                                   | 前の版に戻す: `sudo /opt/sakura-factory/app/deploy/scripts/update.sh <前のコミット>`                                                                                            |
| setup.sh が SSH の鍵で止まる | `authorized_keys` に鍵がない                                                                       | 鍵でログインできるようにしてから流し直す（締め出しを防ぐため、鍵がないとパスワードでのログインを止めない）                                                                      |
| `@agent` に反応しない        | `journalctl -u factory -o cat \| grep webhook` に `"result":"ignored"` と `reason`                 | `not_allowed` なら `factory.toml` の `[github] allowed_users`、`permission` ならリポジトリの権限（書き込み以上）を確かめる                                                      |
| Webhook が `500` を返した    | `journalctl -u factory -o cat \| grep -E '権限を確かめられません\|ジョブを積めません'` に配送の ID | 原因（App が入っていない・GitHub の障害など）を直してから、GitHub の App の設定 → Advanced → Recent Deliveries で、その配送の「Redeliver」を押す（GitHub は自動では再送しない） |
