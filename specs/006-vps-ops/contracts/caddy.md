# Contract: Caddy（006）

## 環境変数（`/etc/caddy/caddy.env`、ひな形は `deploy/caddy.env.example`）

| 変数 | 本番 | 予行演習 | 説明 |
|---|---|---|---|
| `FACTORY_DOMAIN` | 例: `factory.<運用者のドメイン>` | `factory.test` | ファクトリー（GitHub の Webhook の宛先） |
| `STAGING_DOMAIN` | 例: `staging.<運用者のドメイン>` | `staging.test` | ステージングのデモアプリ |
| `CADDY_TLS` | ACME の連絡先のメールアドレス | `internal` | `tls` ディレクティブの引数にそのまま入る |

- 3つとも必須。リポジトリには値を書かない（ひな形は空）。`setup.sh` は空なら止まる

## `deploy/Caddyfile`

```caddyfile
{$FACTORY_DOMAIN} {
	tls {$CADDY_TLS}
	encode zstd gzip

	@factory path /healthz /webhook /status
	handle @factory {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		respond "not found" 404
	}
}

{$STAGING_DOMAIN} {
	tls {$CADDY_TLS}
	encode zstd gzip
	reverse_proxy 127.0.0.1:3100
}
```

## ポートの決まり

| 待ち受け | アドレス | 持ち主 |
|---|---|---|
| ファクトリー | `127.0.0.1:8787` | 006（`factory.toml` の `[http]`。変えるなら Caddyfile も変える） |
| ステージングのデモアプリ | `127.0.0.1:3100` | 010（compose で `127.0.0.1:3100:<コンテナのポート>` にだけ公開する。`0.0.0.0` に公開すると Docker が ufw を迂回して外から届くため） |
| Caddy | `:80`・`:443` | Caddy |

## 振る舞い

| 要求 | 結果 |
|---|---|
| `https://$FACTORY_DOMAIN/healthz` | ファクトリーの応答 |
| `https://$FACTORY_DOMAIN/その他` | Caddy が `404`（ファクトリーに届かない） |
| `https://$STAGING_DOMAIN/...` | デモアプリの応答。止まっていれば Caddy が `502` |
| `http://...` | `308` で `https://` へ（Caddy の自動 HTTPS） |

## 検査（`pnpm run deploy:lint`）

- `docker run --rm caddy:2.11.9` に Caddyfile を読ませ、偽の環境変数（`factory.test`・`staging.test`・`internal`）で `caddy validate --adapter caddyfile` と `caddy fmt --diff` を実行する。どちらかが失敗したら失敗
