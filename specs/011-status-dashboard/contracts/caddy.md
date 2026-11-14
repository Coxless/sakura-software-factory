# Contract: Caddy の Basic 認証（006 への追加）

006 の [caddy.md](../../006-vps-ops/contracts/caddy.md) に足す。

## 環境変数（`/etc/caddy/caddy.env`）

| 変数 | 本番 | 予行演習 | 説明 |
|---|---|---|---|
| `STATUS_USER` | 運用者が決める | `rehearsal` | `/status` の利用者名 |
| `STATUS_PASSWORD_HASH` | `caddy hash-password` の出力を単一引用符で囲む | 予行演習で作ったハッシュ | bcrypt のハッシュ。平文は置かない |

- 2つとも必須（`setup.sh` は空なら止まる）。リポジトリには値を書かない
- 単一引用符で囲む: `STATUS_PASSWORD_HASH='$2a$14$...'`（`setup.sh` の `source` が `$` を展開しないように）

## `deploy/Caddyfile`（ファクトリーのドメインの部分）

```caddyfile
{$FACTORY_DOMAIN} {
	tls {$CADDY_TLS}
	encode zstd gzip

	# 状況ページ（011）は Basic 認証を通ったものだけを転送する
	handle /status {
		basic_auth {
			{$STATUS_USER} {$STATUS_PASSWORD_HASH}
		}
		reverse_proxy 127.0.0.1:8787
	}
	@factory path /healthz /webhook
	handle @factory {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		respond "not found" 404
	}
}
```

## 振る舞い

| 要求 | 結果 |
|---|---|
| `https://$FACTORY_DOMAIN/status`（認証なし・誤り） | Caddy が `401`（`WWW-Authenticate: Basic`）。ファクトリーに届かない |
| `https://$FACTORY_DOMAIN/status`（正しい認証） | ファクトリーの応答 |
| `/healthz`・`/webhook` | これまでどおり（認証なし） |

## 検査

- `deploy:lint`: 偽の `STATUS_USER`・`STATUS_PASSWORD_HASH`（検査用の固定のハッシュ）を渡して `caddy validate`
- `deploy:rehearsal`: 認証なしで `401`、正しい認証で `200`、誤ったパスワードで `401`
