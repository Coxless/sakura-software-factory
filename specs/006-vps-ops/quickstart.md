# Quickstart: VPS配備と秘密情報スキャン（006）

本機能が動くことを確かめる手順。コマンドは Workshop の中で実行する（`workshop exec dev -- <command>`）。LLM・GitHub の API は使わない。

## 1. 常駐プロセスと `/healthz`

```bash
pnpm start &                       # factory.toml（provider = "sakura"。起動時に LLM は呼ばない）
curl -i http://127.0.0.1:8787/healthz
# → HTTP/1.1 200、{"status":"ok"}、Cache-Control: no-store
curl -i http://127.0.0.1:8787/nope
# → HTTP/1.1 404、{"error":"not_found"}
kill -TERM %1; wait %1; echo $?
# → 10 秒以内に終わり、0。ログに "factory stopped"
```

- 起動しているときに同じポートでもう1つ起動すると、アドレスとポートを含む `fatal` を出して終了コード 1
- `FACTORY_CONFIG=factory.dev.toml pnpm start` はこれまでどおり起動を拒否する
- 自動テスト: `pnpm run check`（`src/http/*.test.ts`・`src/config.test.ts`）

## 2. 秘密情報スキャン

```bash
gitleaks version                   # → 8.30.1（setup-project で入る）
pnpm run secrets:scan              # → 0。履歴全体で leaks なし（テスト用の偽の値は .gitleaks.toml で個別に許可）
```

失敗することの確認（コミットしない）:

```bash
git stash -u 2>/dev/null; printf 'token = "ghp_%s"\n' "$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 36)" > leak.txt
gitleaks dir --no-banner --config .gitleaks.toml leak.txt; echo $?   # → 1
rm leak.txt; git stash pop 2>/dev/null || true
```

CI では、同じ偽の値を含むブランチを push して CI が赤になることを1回確かめる（確かめたらブランチを消す）。

## 3. 配備物の文法の検査

```bash
pnpm run deploy:lint
# → shellcheck: ok / systemd-analyze: ok / caddy validate: ok / caddy fmt: ok、終了コード 0
```

## 4. 予行演習（解禁の前に最低1回）

```bash
pnpm run deploy:rehearsal
```

中で確かめる項目（どれか1つでも失敗したら、その項目を出して 1 で終わる）:

| # | 確認 | 期待 |
|---|---|---|
| 1 | `setup.sh` の1回目（秘密情報のファイルなし） | ひな形を置いて止まる（終了コード 1、手順7） |
| 2 | 偽の値を書いて `setup.sh` を流し直す | 0。最後に `deployed <HEAD のコミット>` |
| 3 | `systemctl is-active factory caddy docker` | すべて `active` |
| 4 | `curl -sk --resolve factory.test:443:127.0.0.1 https://factory.test/healthz` | `{"status":"ok"}` |
| 5 | `curl -sk --resolve factory.test:443:127.0.0.1 https://factory.test/other` | `404`（Caddy） |
| 6 | `curl -sk --resolve staging.test:443:127.0.0.1 https://staging.test/` | 仮のアプリの応答 |
| 7 | 仮のアプリを止めて 6 | `502`。4 は `200` のまま |
| 8 | `curl -si http://factory.test/healthz --resolve factory.test:80:127.0.0.1` | `308`、`Location: https://` |
| 9 | `stat -c '%U:%G %a' /etc/sakura-factory/factory.env` | `root:factory 640` |
| 9b | `stat -c '%U %a' /var/lib/sakura-factory`、`stat -c '%a' /var/lib/sakura-factory/factory.db` | `factory 750`、`640` |
| 10 | `kill -9 <factory の PID>` から 30 秒以内に 4 | `{"status":"ok"}`（PID が変わる） |
| 11 | `journalctl -u factory -o cat -n 1` | JSON の1行 |
| 12 | DB のダンプのハッシュを取ってから `setup.sh` をもう一度 → ハッシュを比べる | 2回目も 0、ハッシュが同じ |
| 13 | `ufw status` | 22・80・443 だけ ALLOW |
| 14 | `git -C /opt/sakura-factory/app rev-parse HEAD` | 開発機の HEAD と同じ |
| 15 | `gitleaks version` | `8.30.1` |
| 16 | `curl -o /dev/null -sk -w '%{time_total}' --resolve factory.test:443:127.0.0.1 https://factory.test/healthz` を 10 回 | 2回目以降がすべて 0.1 秒以内（SC-005） |
| 17 | 全体の所要時間 | 15 分以内 |

終わったあと:

```bash
docker ps -a --filter label=sakura-factory.rehearsal=1   # → 何も出ない
docker volume ls --filter label=sakura-factory.rehearsal=1  # → 何も出ない
```

## 5. VPS解禁の日（日付は `docs/実装計画.md` 3章）

`deploy/README.md` を上から流す。予行演習との違いは、取得元が GitHub、`CADDY_TLS` がメールアドレス、ドメインが本物、SSH の設定を飛ばさないことだけ。
