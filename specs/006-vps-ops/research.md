# Research: VPS配備と秘密情報スキャン（006）

各項目は「決定・理由・検討した代替」の順に書く。バージョンは 2026-11-11 に確かめた。

## R1. HTTP サーバー

- **決定**: Hono 4.13.17 ＋ `@hono/node-server` 2.1.6（完全固定）。`src/http/app.ts` にアプリ（ルート定義だけ。テストは `app.request()` で行い、ポートを開かない）、`src/http/server.ts` に待ち受けと停止処理を置く
- **理由**: constitution の主要ライブラリ。後続の `/webhook`（007）・`/status`（011）を同じアプリに足せる。`app.request()` で HTTP を立てずにテストできる
- **代替**: `node:http` を直接使う → 007 の署名検証のミドルウェアと 011 の画面で結局フレームワークが要る

## R2. 生存確認の中身

- **決定**: `GET /healthz`（`HEAD` も同じ）で、開いているデータベースに `SELECT 1` を実行する。成功で `200 {"status":"ok"}`、例外で `503 {"status":"unhealthy"}`。`Cache-Control: no-store`。例外の内容はログにだけ出す（本文には出さない）
- **理由**: FR-003。プロセスが生きているだけでなく、ジョブの記録に要るデータベースまで使えるかを見る。SQLite は同じプロセスの中なので速い（SC-005）
- **ロックの扱い**: 001 の `busy_timeout = 5000` は生存確認には長い。生存確認では、読み取りの `SELECT 1` は WAL のもとで書き込みに妨げられないので、追加の設定はしない。ロックで待つことがあれば `503` になるだけで待ち受けは止まらない
- **代替**: LLM の疎通まで見る → 予算を消費する（FR-004 に反する）。Docker の疎通まで見る → 生存確認が Docker の障害で落ち、systemd の再起動と混ざる。Docker の状態は 007 の Worker のログで見る

## R3. 停止処理

- **決定**: SIGTERM・SIGINT で `server.close()` を呼び、`[http] shutdown_timeout_seconds`（既定 10、1〜60）を過ぎたら残りの接続を閉じて終わる。2回目の合図では即座に終わる（終了コード 130/143）。終わる前にデータベースを閉じる
- **理由**: FR-005、SC-004。systemd の `TimeoutStopSec` を上限より長く（20 秒）して、systemd の強制終了より先にプロセスが自分で終わるようにする
- **代替**: 何もしない（systemd に任せる）→ SQLite の WAL がチェックポイントされずに残る

## R4. 待ち受けの設定

- **決定**: `factory.toml` に `[http]`（`host` 既定 `127.0.0.1`、`port` 既定 `8787`、`shutdown_timeout_seconds` 既定 10）を足す。セクションごと省略できる。`host` がループバック以外なら起動時に `warn` を出す
- **理由**: FR-002。Caddy を通さない公開を避ける。ポートは Caddyfile と合わせる必要があるので、既定値を契約に書く（[contracts/caddy.md](./contracts/caddy.md)）
- **代替**: 環境変数で渡す → 001 の方針（設定は `factory.toml`、秘密情報だけ環境変数）に反する

## R5. VPS のディレクトリと設定ファイル

- **決定**:
  - コード: `/opt/sakura-factory/app`（root の所有。ファクトリーのユーザーは読むだけ）
  - 設定: `/etc/sakura-factory/factory.toml`（初回だけリポジトリの `factory.toml` から作り、`[storage]` を `/var/lib/sakura-factory` に向ける。以後は上書きしない）。`FACTORY_CONFIG` で渡す
  - 秘密情報: `/etc/sakura-factory/factory.env`（`root:factory`、`0640`）
  - データ: `/var/lib/sakura-factory`（systemd の `StateDirectory=`。DB・軌跡。007 のジョブの作業ディレクトリもこの下に置く）
- **理由**: コードと設定とデータを分け、更新（`git checkout`）でデータと設定が消えないようにする（FR-022）。コードを root の所有にして、ファクトリーのプロセスが自分のコードを書き換えられないようにする
- **作業ディレクトリの注意**: 作業場（003）は Docker デーモンがホストのパスを bind mount する。systemd の `PrivateTmp=yes` の `/tmp` はデーモンから見えないので、作業ディレクトリは `/tmp` ではなく `StateDirectory` の下に置く（007 への申し送り。`03` 5章に書く）
- **代替**: リポジトリの `factory.toml` をそのまま使う → データがコードの下に入り、`ProtectSystem=strict` の書き込み許可がコード全体に広がる

## R6. systemd のユニット

- **決定**: [contracts/systemd.md](./contracts/systemd.md) のとおり。要点は `User=factory`・`SupplementaryGroups=docker`・`Restart=on-failure`（`RestartSec=5`、`StartLimitIntervalSec=300`・`StartLimitBurst=5`）・`After=/Requires=docker.service`・`After=/Wants=network-online.target`・`NoNewPrivileges=yes`・`ProtectSystem=strict`・`ProtectHome=yes`・`PrivateTmp=yes`・`StateDirectory=sakura-factory`・ログは標準出力（journald）
- **理由**: FR-008〜FR-012、SC-003（5 秒後に再起動 → 起動・マイグレーションで数秒）
- **代替**: Docker コンテナでファクトリーを動かす → 作業場の Docker を中から操作することになり、ソケットの受け渡しで結局同じ権限になる上に構成が複雑になる

## R7. Docker への接続（Complexity Tracking の対象）

- **決定**: `factory` ユーザーを `docker` グループに入れる（spec の Clarifications）
- **理由と代替**: plan の Complexity Tracking に書く

## R8. ランタイム・ツールの入れ方とバージョン

| もの | 入れ方 | 固定するもの |
|---|---|---|
| Node.js | nodejs.org の公式 tarball（`linux-x64`）を `SHASUMS256.txt` で確かめて `/opt/node-v<ver>` に展開し、`/opt/node` をリンクにする | `v24.22.2`（2026-10-27、LTS Krypton）。CI・Workshop は 24 系の最新に追従するので、差はパッチ版だけ |
| pnpm | Node 同梱の corepack。`package.json` の `packageManager` に従う | `pnpm@12.18.0`（既存） |
| Docker・compose | Ubuntu の `docker.io`・`docker-compose-v2`（Workshop の `setup-base` と同じ） | Ubuntu 24.04 の配布物に従う（spec FR-024） |
| Caddy | 公式の apt リポジトリ（`dl.cloudsmith.io/public/caddy/stable`）から版を指定して入れ、`apt-mark hold` する | `2.11.9`（Docker Hub の `caddy` イメージの最新タグで確認） |
| gitleaks | 公式のリリースの tarball を、スクリプトに書いたチェックサムで確かめて `/usr/local/bin` に置く（R10） | `8.30.1` |
| shellcheck | Ubuntu の `shellcheck`（Workshop と VPS）。CI のランナーには最初から入っている | 配布物に従う |

- **理由**: FR-024。Node と gitleaks はチェックサムまで固定する。Caddy は apt リポジトリの署名で確かめる
- **代替**: NodeSource の apt リポジトリ → 版の固定が apt のピン止めになり、チェックサムを自分で持てない。Caddy をコンテナで動かす → ホストの 80/443 を持つので、systemd で直接動かすほうが単純

## R9. Caddy の設定

- **決定**: [contracts/caddy.md](./contracts/caddy.md) のとおり。ドメインと TLS の指定は環境変数（`FACTORY_DOMAIN`・`STAGING_DOMAIN`・`CADDY_TLS`）で与え、Caddy の systemd ユニットに drop-in で `EnvironmentFile=/etc/caddy/caddy.env` を足す。`CADDY_TLS` は本番では ACME の連絡先のメールアドレス、予行演習では `internal`（`tls` ディレクティブの引数にそのまま入る）
- **理由**: FR-013〜FR-019。1つの Caddyfile で本番と予行演習を切り替えられ、リポジトリにドメインを書かない（SC-006）
- **ステージングの転送先**: `127.0.0.1:3100` に決める。010 はデモアプリをこのポートに出す
- **公開するパス**: ファクトリーのドメインでは `/healthz`・`/webhook`・`/status` だけを転送し、ほかは Caddy が `404` を返す（spec の Clarifications）
- **代替**: `local_certs` のグローバル設定を別ファイルにして切り替える → ファイルが増える。ドメインを Caddyfile に書く → 公開リポジトリに実値が載る

## R10. gitleaks の入れ方と使い方

- **決定**:
  - 入れ方: `scripts/install-gitleaks.sh` を Workshop の `setup-base`・CI・VPS の配備スクリプトの3か所から呼ぶ。版とアーキテクチャごと（`linux_x64`・`linux_arm64`）の SHA-256 をこのスクリプトだけに書き、一致しなければ入れずに失敗する。入っている版が同じなら何もしない
  - 使い方: `pnpm run secrets:scan`（`gitleaks git --redact --no-banner --config .gitleaks.toml .`）。履歴全体をスキャンする（spec の Clarifications）。CI は `actions/checkout` に `fetch-depth: 0` を付ける
  - 許可リスト: `.gitleaks.toml` で既定の規則を引き継ぎ（`[extend] useDefault = true`）、テスト用の偽の値を、ファイルと値の正規表現の組で個別に許可する。規則全体・ディレクトリ全体は除外しない（FR-032）
- **2026-11-11 に Docker Hub の `zricethezav/gitleaks:v8.30.1` で今のリポジトリ（28 コミット）をスキャンした結果**: 4 件。すべてテスト用の偽の値
  - `generic-api-key` `src/pipeline/implement.test.ts:531`
  - `generic-api-key` `src/llm/testing.ts:289`
  - `generic-api-key` `src/log.test.ts:5`
  - `private-key` `src/trace/mask.test.ts:21`
- **チェックサム**: このクラウドの作業環境からは `github.com` のリリースに届かなかった（プロキシが 403）。tarball の SHA-256 は、実装のときに Workshop で公式の `gitleaks_8.30.1_checksums.txt` から写す（tasks に入れる）
- **理由**: FR-029〜FR-032。3か所で同じスクリプトを使えば版がずれない（SC-008）
- **代替**: CI で公式の GitHub Action を使う → ローカルと別のコマンドになり（constitution の開発ワークフロー）、Action 自体の版の管理も増える。Docker イメージで動かす → VPS で 008 が毎回コンテナを起動することになる

## R11. 配備のスクリプト

- **決定**:
  - `deploy/scripts/setup.sh`（root で実行。冪等）: パッケージ → Node → gitleaks → Caddy → ユーザーとディレクトリ → コードの取得 → 設定と秘密情報のファイルの確認 → systemd と Caddy の設定 → ファイアウォールと SSH → `update.sh` を呼ぶ
  - `deploy/scripts/update.sh [ref]`（root で実行）: `git fetch` → 指定のコミットかタグ（既定 `origin/main`）をチェックアウト → `pnpm install --frozen-lockfile --prod` → 作業場のイメージのビルド → マイグレーション（`factory` ユーザーで）→ 再起動 → 生存確認を 30 秒まで待つ → 動いているコミットを表示
  - どちらも `set -euo pipefail` と、手順の名前を出してから実行する関数（`step "..."`）で、失敗した手順がわかるようにする（FR-023）
  - 秘密情報のファイルがない・権限が `0640` より広い・所有者が違う場合は、ひな形の場所を示して止まる（Edge Cases）
- **理由**: FR-020〜FR-026。手順書は「何を確かめるか」を書き、実際の作業はスクリプトに寄せる。手順書とスクリプトがずれないよう、手順書はスクリプトの手順の名前をそのまま見出しにする
- **代替**: Ansible など → 1台の VPS に対して過剰。読者が再現しにくい

## R12. ファイアウォールと SSH

- **決定**: `ufw` で受信を既定で拒否し、`22/tcp`・`80/tcp`・`443/tcp` だけを許可する。SSH は `/etc/ssh/sshd_config.d/50-sakura-factory.conf` で `PasswordAuthentication no`・`PermitRootLogin prohibit-password`。SSH の設定を変える前に、`authorized_keys` に鍵が1つ以上あることを確かめ、なければ止まる（締め出しを防ぐ）
- **理由**: FR-025。さくらのVPS のパケットフィルターは画面での設定なので、手順書で同じ3ポートにすることを確かめる
- **Docker と ufw**: Docker が公開したポートは ufw を迂回する。ステージング（010）は `127.0.0.1:3100` にだけ公開する決まりにして、外から届かないようにする（contracts/caddy.md）

## R13. 予行演習

- **決定**: `pnpm run deploy:rehearsal`（`deploy/rehearsal/run.sh`）。`deploy/rehearsal/Dockerfile`（`ubuntu:24.04` ＋ systemd を PID 1）のコンテナを特権付きで起動し、HEAD の `git bundle` を中に入れて `FACTORY_REPO_URL` にし、`setup.sh` をそのまま流す。秘密情報は偽の値、`CADDY_TLS=internal`、ドメインは `factory.test`・`staging.test`。ステージングの代わりに `127.0.0.1:3100` で応答する仮のアプリを動かす。確かめる項目は [quickstart.md](./quickstart.md) の4章。終わったら `trap` で必ず片付ける
- **理由**: FR-027・FR-028、SC-001・SC-002。本番と同じスクリプトを流すので、解禁の日の失敗を前倒しで見つけられる
- **2026-11-11 時点の制約**: このクラウドの作業環境は cgroup v1 で、systemd のコンテナが動くかは未確認。予行演習の実行は Workshop（または開発機の Docker）で行う
- **代替**: Workshop の別インスタンスに流す → Workshop の定義（`setup-base`）と混ざる。Multipass などの VM → 開発機の前提が増える

## R14. 文法の検査

- **決定**: `pnpm run deploy:lint`（`deploy/scripts/lint.sh`）で次を行う。CI もこのコマンドを呼ぶ
  - `shellcheck` を `deploy/**/*.sh` と `scripts/*.sh` に
  - `systemd-analyze verify` を `deploy/systemd/*.service` に。`ExecStart` の `/opt/node/bin/node` は検査する機械にないので、一時ファイルに写して `/bin/true` に置き換えてから検査する。知らない設定名は警告だけで終了コードが 0 になるので、出力が1行でもあれば失敗にする（2026-11-11 に systemd 255 で確認。`--root` に仮のディレクトリを渡す方法は `sysinit.target` などが見つからず使えなかった）
  - `caddy validate` と `caddy fmt --diff` を Caddy の公式イメージ（`caddy:2.11.9`）で、偽の環境変数を渡して
- **理由**: FR-018・FR-034。`pnpm run check` は Docker なしでも通る今の形を保つため、別のコマンドにする
- **代替**: `check` に入れる → Docker がない環境で `check` が通らなくなる
