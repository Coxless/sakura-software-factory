# 006 vps-ops と gitleaks の spec・plan・tasks

005（local-pipeline）をローカルで実装している間に、依存先が 001 だけの 006（VPS配備）と、008 の前提の gitleaks を並行して進めることにした。spec → clarify → plan → tasks → analyze まで、クラウドの作業環境（Claude Code on the web）で行った。

## 進め方

- 人間の確認が要る点は、いったん推奨の内容で決めて進めた（spec の Clarifications に5点を記録。`docker` グループ、VPS への届け方は git clone、`/healthz` は公開する、gitleaks は履歴全体、予行演習は特権付きのコンテナ）。あとで覆す場合は spec の Clarifications から直す
- spec のディレクトリは、Spec Kit の連番に任せると `specs/005-...` になってしまう（005 はローカルで作業中）。`docs/実装計画.md` の番号に合わせて `specs/006-vps-ops` を明示した

## 調べて分かった事実

### バージョン（2026-11-11）

| もの | 版 | 確かめ方 |
|---|---|---|
| hono | 4.13.17（2026-11-07） | `registry.npmjs.org/hono` の `dist-tags.latest` |
| @hono/node-server | 2.1.6（2026-11-02） | 同上 |
| Node.js 24 | v24.22.2（2026-10-27、LTS Krypton） | `nodejs.org/dist/index.json` |
| gitleaks | 8.30.1 | Docker Hub の `zricethezav/gitleaks` のタグ（最新が 2026-03-21 の v8.30.1） |
| Caddy | 2.11.9 | Docker Hub の `caddy` のタグ（2026-11-10 更新） |

- `npm view` は、このリポジトリの `devEngines`（pnpm 指定）で `EBADDEVENGINES` になって使えなかった。registry の JSON を直接読んだ
- このクラウドの作業環境からは `github.com`・`caddyserver.com`・`dl.cloudsmith.io` に届かなかった（`curl: (56) CONNECT tunnel failed, response 403`）。GitHub のリリース一覧と gitleaks の `checksums.txt` を読めないので、tarball の SHA-256 は実装のときに Workshop で写す（tasks T013）。Docker Hub（`hub.docker.com` と `registry-1.docker.io`）と `nodejs.org` には届いた
- Docker Hub の gitleaks の最新タグが 2026-03 で止まっているのが気になる（GitHub のリリースはもっと新しいかもしれない）。Workshop で GitHub のリリースを見て、新しければ版を上げる

### gitleaks の初回のスキャン

このクラウドの作業環境で `dockerd` を手で起動し、Docker Hub のイメージで今のリポジトリをスキャンした。

```
docker run --rm -v "$PWD":/repo -w /repo zricethezav/gitleaks:v8.30.1 git --redact --no-banner -v .
INF 23 commits scanned.
INF scanned ~1359352 bytes (1.36 MB) in 335ms
WRN leaks found: 4
```

（`git rev-list --count HEAD` は 28。gitleaks の数え方はマージコミットを除くらしい）

| 規則 | ファイル | 行 | コミット |
|---|---|---|---|
| generic-api-key | src/pipeline/implement.test.ts | 531 | ac6bec3 |
| generic-api-key | src/llm/testing.ts | 289 | 123375e |
| generic-api-key | src/log.test.ts | 5 | eb84261 |
| private-key | src/trace/mask.test.ts | 21 | eb84261 |

4件ともテスト用の偽の値。`.gitleaks.toml` でファイルと値の組で1件ずつ許可する（規則やディレクトリごとは除外しない）。所要時間は 335ms なので、履歴全体を毎回スキャンしても CI の負担にならない。

### systemd-analyze verify の癖（systemd 255.4-1ubuntu8.18）

- `ExecStart` の実行ファイルが検査する機械にないと失敗する: `factory.service: Command /opt/node/bin/node is not executable: No such file or directory`（終了コード 1）
- `--root` に仮のディレクトリ（`/opt/node/bin/node` の仮のファイル入り）を渡す方法は使えなかった。ユニットをパスで渡すと `Unit factory.service not found.`、ルートの中に置くと `Failed to create factory.service/start: Unit sysinit.target not found.`（`docker.service` を書けば `Unit docker.service not found.`）
- `ExecStart` を `/bin/true` に置き換えた写しは 0 で通った
- **知らない設定名は警告だけで、終了コードは 0**: `bad.service:2: Unknown key name 'BogusKey' in section 'Service', ignoring.` → rc=0。綴りの誤りを見逃すので、`deploy:lint` では出力が1行でもあれば失敗にする

### このクラウドの作業環境の Docker

- 最初は `/var/run/docker.sock` がなかった。`dockerd` を手で起動すると数秒で使えた（Docker 29.9.2、cgroupfs、**cgroup v1**）
- 予行演習の systemd 付きのコンテナが cgroup v1 で動くかは確かめていない。予行演習の実行は Workshop で行う

## analyze で直したこと

- `docker` グループを、constitution 原則 IV の「違反」として Complexity Tracking に書いていた。IV は NON-NEGOTIABLE で違反を許容しないので、書き方と食い違う。IV の MUST はどれも破っていないので、「違反ではなく残るリスク」と書き直した
- FR 番号を振り直したあと、contracts の1か所が古い番号のままだった
- 運用者がどこに clone してから `setup.sh` を流すのかが書かれていなかった → `/opt/sakura-factory/app` に clone して、そこのスクリプトを流すと明記した
- SC-005（`/healthz` が 100ms 以内）と SC-006（ドメインの実値を書かない）を確かめる手順がなかった → 予行演習の確認項目と T033 に足した
- 「テストを先に書く」と言いながら、main の停止処理のテストが実装の後ろに並んでいた → 順番を入れ替えた

## まだ分かっていないこと

- Workshop の `setup-base` が実行されるときに `/project` が見えるか（`scripts/install-gitleaks.sh` を呼べるか）
- 予行演習のコンテナの中で ufw（iptables）と Docker が動くか
- `ProtectSystem=strict` などの保護設定のもとで、ファクトリーから Docker のソケットを問題なく使えるか
