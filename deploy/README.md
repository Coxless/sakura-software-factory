# VPS 配備の手順書

さくらのVPS（Ubuntu 24.04 LTS）にファクトリーを配備する手順。VPS解禁の日（2026-12-03）は、この手順を上から流すだけにする。

この構成では、LLM の推論は さくらのAI Engine（ZDR）だけで行い、推論を国産・ZDRで閉じる。VPS はファクトリー本体・作業場（ジョブごとの Docker コンテナ）・ステージングを1台で動かし、Caddy で HTTPS を受ける。リポジトリは GitHub のまま。

- 仕様: `specs/006-vps-ops/`（配置は `contracts/deploy.md`、Caddy は `contracts/caddy.md`、systemd は `contracts/systemd.md`）
- 事前の予行演習: `pnpm run deploy:rehearsal`（ローカルの Docker で同じスクリプトを流す。`specs/006-vps-ops/quickstart.md` 4章）
- ドメインは例として `factory.example.jp`・`staging.example.jp` と書く。実際の値はリポジトリに書かない

## 1. 事前の確認

| 確認すること | 確かめ方 | 期待する結果 |
|---|---|---|
| OS | `lsb_release -ds` | `Ubuntu 24.04.x LTS` |
| SSH の鍵でログインできる | 手元から `ssh <user>@<VPS の IP>` | パスワードを聞かれずに入れる |
| DNS が VPS を向いている | 手元から `dig +short factory.example.jp` と `dig +short staging.example.jp` | どちらも VPS の IP |
| さくらのパケットフィルター | コントロールパネルの「パケットフィルター」 | 22・80・443（TCP）だけを許可 |
| さくらのAI Engine の APIキー | コントロールパネル | 手元に控えてある（チャットやリポジトリに貼らない） |

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

```bash
sudoedit /etc/sakura-factory/factory.env   # SAKURA_AI_API_KEY=...
sudo /opt/sakura-factory/app/deploy/scripts/setup.sh   # 今度は caddy.env のひな形を置いて止まる
sudoedit /etc/caddy/caddy.env              # FACTORY_DOMAIN・STAGING_DOMAIN・CADDY_TLS（メールアドレス）
```

確かめ方:

```bash
sudo stat -c '%U:%G %a %n' /etc/sakura-factory/factory.env /etc/caddy/caddy.env
```

期待する出力:

```
root:factory 640 /etc/sakura-factory/factory.env
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

| 確認 | コマンド | 期待する結果 |
|---|---|---|
| サービス | `systemctl is-active factory caddy docker` | 3行とも `active` |
| 生存確認（外から） | 手元から `curl -s https://factory.example.jp/healthz` | `{"status":"ok"}` |
| 公開していないパス | 手元から `curl -s -o /dev/null -w '%{http_code}\n' https://factory.example.jp/` | `404` |
| HTTP から HTTPS へ | 手元から `curl -sI http://factory.example.jp/healthz` | `308` と `Location: https://...` |
| ログ | `journalctl -u factory -o cat -n 5` | JSON の行（`"msg":"factory started"` を含む） |
| ファイアウォール | `sudo ufw status` | `22/tcp`・`80/tcp`・`443/tcp` だけ `ALLOW` |
| ファクトリーのポートが外から届かない | 手元から `nc -zv -w 3 <VPS の IP> 8787` | 届かない（タイムアウトか拒否） |
| 動いている版 | `git -C /opt/sakura-factory/app rev-parse HEAD` | 4章の `deployed` のコミット |
| gitleaks | `gitleaks version` | `8.30.1` |
| 自動の再起動 | `sudo systemctl kill -s KILL factory`、30 秒後に `curl -s https://factory.example.jp/healthz` | `{"status":"ok"}` |

ステージング（`https://staging.example.jp`）は 010 でデモアプリを置くまで `502` を返す（想定どおり）。

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

（`[storage]` の2行だけが違うのが正しい状態）

## 7. 困ったとき

| 症状 | 確かめ方 | 対処 |
|---|---|---|
| HTTPS がつながらない | `journalctl -u caddy -n 50 --no-pager` に `obtaining certificate` の失敗 | DNS（1章）とパケットフィルターの 80・443 を確かめ、`sudo systemctl restart caddy` |
| `factory` が止まったまま | `systemctl status factory` に `start request repeated too quickly` | `journalctl -u factory -n 100 -o cat` で原因を直し、`sudo systemctl reset-failed factory && sudo systemctl start factory` |
| 更新した版で動かない | `update.sh` が「生存確認」で失敗 | 前の版に戻す: `sudo /opt/sakura-factory/app/deploy/scripts/update.sh <前のコミット>` |
| setup.sh が SSH の鍵で止まる | `authorized_keys` に鍵がない | 鍵でログインできるようにしてから流し直す（締め出しを防ぐため、鍵がないとパスワードでのログインを止めない） |
