# Contract: GitHub App（007）

運用者が手で作る。手順は `deploy/README.md` に足す。

## 権限（`03` 5章）

| 権限 | 範囲 | 007 で使うもの |
|---|---|---|
| Issues | 読み書き | コメント・リアクション |
| Pull requests | 読み書き | 008 で使う |
| Contents | 読み書き | 取得（clone）。push は 008 |
| Checks・Actions | 読み取り | 009 で使う |
| Metadata | 読み取り | 必須 |
| Workflows | **与えない** | — |

イベント: `issue_comment`（007）、`check_suite`（009）、`pull_request`（008）、`push`（010）。Webhook の URL は `https://<FACTORY_DOMAIN>/webhook`、Content type は `application/json`、秘密は `GITHUB_WEBHOOK_SECRET` と同じ値。

## 環境変数（`/etc/sakura-factory/factory.env`）

| 名前 | 中身 |
|---|---|
| `GITHUB_APP_ID` | App の ID（数字） |
| `GITHUB_APP_PRIVATE_KEY_PATH` | App の秘密鍵（PEM）のファイルの場所。既定の置き場所は `/etc/sakura-factory/github-app.pem`（`root:factory`、`0640`） |
| `GITHUB_WEBHOOK_SECRET` | Webhook の秘密（32 バイト以上の乱数。例: `openssl rand -hex 32`） |

- 3つともないと、`pnpm start` は名前を含むエラーで起動しない
- 006 の `setup.sh` は、3つが空でないことと、秘密鍵のファイルの所有者と権限を確かめる

## トークンの扱い

- インストールトークン（1時間で切れる）は `octokit` の `App` が発行・更新する。保存しない
- git には環境変数（`GIT_CONFIG_COUNT`・`GIT_CONFIG_KEY_0`・`GIT_CONFIG_VALUE_0`）で渡す。`.git/config`・リモートの URL・コマンドラインの引数に入れない
- 作業場（コンテナ）には渡さない（003 のまま、環境変数は `HOME=/tmp` だけ）
