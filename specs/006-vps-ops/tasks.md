---

description: "Task list for 006 vps-ops"
---

# Tasks: VPS配備と秘密情報スキャン（vps-ops）

**Input**: Design documents from `specs/006-vps-ops/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。FR-033・FR-034 が自動テスト・自動の検査を求めているため。`src/` のコードはテストを先に書いて失敗を確かめてから実装する。配備物は `deploy:lint` と予行演習で確かめる。

**Organization**: ユーザーストーリーごとにまとめる。US1（常駐と `/healthz`）が US2・US3・US5 の前提。US4（gitleaks）は独立していて、いつでも並行できる。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- シェルスクリプトは `#!/usr/bin/env bash` と `set -euo pipefail` で始め、shellcheck の警告を0にする。コメントは日本語
- 秘密情報の値・ドメインの実値をどのファイルにも書かない（ひな形は空の値）
- 想定と違う挙動・エラーに当たったら `docs/journal/<実装した日>-006-vps-ops.md` に記録する（コマンドと出力をそのまま）

---

## Phase 1: Setup

- [X] T001 hono と @hono/node-server を完全固定で入れる（`pnpm add hono@4.13.17 @hono/node-server@2.1.6`）。`package.json` に `^` `~` がないことを確かめる
- [X] T002 [P] `package.json` に `secrets:scan`（`gitleaks git --redact --no-banner --config .gitleaks.toml .`）・`deploy:lint`（`bash deploy/scripts/lint.sh`）・`deploy:rehearsal`（`bash deploy/rehearsal/run.sh`）を足す（contracts/commands.md）
- [X] T003 [P] `deploy/` の骨組みを作る: `deploy/systemd/caddy.service.d/`、`deploy/scripts/`、`deploy/rehearsal/` のディレクトリと、`deploy/scripts/lib.sh`（`step <名前>`: 名前を出して現在の手順として覚える、`die <文>`: `ERROR: <手順> で失敗しました: <文>` を出して 1 で終わる、`trap` で予期しない失敗も同じ形で出す。版の定数 `NODE_VERSION=24.22.2`・`CADDY_VERSION=2.11.9`・`APP_DIR=/opt/sakura-factory/app`・`ETC_DIR=/etc/sakura-factory`・`STATE_DIR=/var/lib/sakura-factory`・`FACTORY_PORT=8787`）

## Phase 2: Foundational（設定）

- [X] T004 `src/config.test.ts` に `[http]` のテストを足す: 省略時に `host = "127.0.0.1"`・`port = 8787`・`shutdown_timeout_seconds = 10`、`port = 0` と `65536` がエラー、`shutdown_timeout_seconds = 0` と `61` がエラー、`host = ""` がエラー、未知の項目がエラー（contracts/factory-toml.md の表）
- [X] T005 `src/config.ts` に `[http]`（`host`: 空でない文字列、既定 `"127.0.0.1"`／`port`: 1〜65535、既定 `8787`／`shutdown_timeout_seconds`: 1〜60、既定 `10`。セクションごと省略可）のスキーマを足す。ループバックかどうかを返す `isLoopbackHost(host)`（`127.0.0.0/8`・`::1`・`localhost`）を export する。`factory.toml` と `factory.dev.toml` に `[http]` を日本語のコメント付きで足す（「port は deploy/Caddyfile と合わせる」）。`specs/001-foundation/contracts/factory-toml.md` から 006 の契約へのリンクを足す

---

## Phase 3: User Story 1 - 生存確認の URL を持つ常駐プロセスとして起動する (Priority: P1) 🎯 MVP

**Goal**: `pnpm start` が待ち受けを続け、`/healthz` がデータベースの状態を返し、停止の合図で正常に終わる

**Independent Test**: quickstart.md の1章

### Tests for User Story 1

- [X] T006 [P] [US1] `src/http/app.test.ts` を書く（`app.request()` を使い、ポートを開かない）: `:memory:` の DB で `GET /healthz` が `200`・`{"status":"ok"}`・`Cache-Control: no-store`・`Content-Type: application/json`、`HEAD /healthz` が `200` で本文なし、DB を閉じたあと（`handle.close()`）は `503`・`{"status":"unhealthy"}` で本文にエラー文やパスを含まず、ロガーに `warn` が1回出る、`GET /nope` が `404`・`{"error":"not_found"}` で本文にパスを含まない、ハンドラーが投げたら `500`・`{"error":"internal_error"}`（contracts/http.md）
- [X] T007 [P] [US1] `src/http/server.test.ts` を書く: ポート 0 で起動して `address` の実ポートに `fetch` すると `/healthz` が `200`、`close()` のあと接続が拒否される、`close()` を2回呼んでも投げない、処理中の要求（テスト用に遅いルートを足したアプリ）があっても `shutdown_timeout_seconds` を過ぎたら `close()` が終わる、同じポートで2つ目を起動すると、アドレスとポートを含むエラーで reject する

### Implementation for User Story 1

- [X] T008 [US1] `src/http/app.ts` を作る: `createApp({ sqlite, logger })` が Hono アプリを返す。`GET /healthz`（HEAD は Hono の既定で同じ）で `sqlite.prepare("SELECT 1").get()` を実行し、成功で `200 {"status":"ok"}`、例外で `logger.warn({ err }, "healthz failed")` と `503 {"status":"unhealthy"}`。どちらも `Cache-Control: no-store`。`notFound` で `404 {"error":"not_found"}`、`onError` で `logger.error` と `500 {"error":"internal_error"}`。後続（007 の `/webhook`、011 の `/status`）が足す場所をコメントで示す。T006 を通す
- [X] T009 [US1] `src/http/server.ts` を作る: `startServer({ app, host, port, shutdownTimeoutSeconds })` が `@hono/node-server` の `serve` で待ち受け、`listening` で resolve、`error`（`EADDRINUSE` など）で `host:port` を含むエラーで reject する。返す `ServerHandle` は `address` と `close()`（`server.close()` を呼び、`shutdownTimeoutSeconds` を過ぎたら `closeAllConnections()`。2回目以降は同じ Promise を返す）（data-model.md の ServerHandle）。T007 を通す
- [X] T010 [US1] `src/main.test.ts` を書き、`main` の停止処理を確かめる（T011 の実装の前に書いて失敗を確かめる）: 一時 DB とポート 0 の設定で起動し、`process.emit("SIGTERM")` 相当（テストでは停止関数を直接呼べるよう `main` から `run(config, { signals })` を切り出す）で 0 が返り、DB が閉じていること。テストのために切り出した関数は `src/main.ts` の中に置く
- [X] T011 [US1] `src/main.ts` を常駐の形に変える: 既存の起動処理（`installStreamFnGuard` → 設定 → `assertProductionProvider` → ロガー → DB を開いてマイグレーション）のあと、DB を閉じずに `createApp` と `startServer` を呼ぶ。`host` がループバック以外なら `warn`（「Caddy を通さずに公開しています」）。`info` "factory started" に `http: { host, port }` を足す。SIGTERM・SIGINT の1回目で `close()` → DB を閉じる → `info` "factory stopped" → 終了コード 0、2回目で即座に終了（SIGINT 130・SIGTERM 143）。待ち受けの失敗は `fatal` → DB を閉じて終了コード 1。`main()` を async にし、T010 のテストのために `run(config, { signals })` を切り出して T010 を通す。ファイル先頭のコメントの「HTTP と Worker は 006・007 で足す」を「Worker は 007 で足す」に直す
- [X] T012 [US1] `specs/001-foundation/contracts/commands.md` の `pnpm start` の行と「001 の `pnpm start` は起動処理を終えたらそのまま終了する」の注記を、006 の contracts/commands.md に合わせて直す。quickstart.md の1章を手で実行して確かめる

**Checkpoint**: `pnpm run check` が通り、`pnpm start` で `/healthz` に応答する

---

## Phase 4: User Story 4 - 秘密情報スキャンをローカル・CI・VPS で同じように使う (Priority: P2)

**Goal**: gitleaks 8.30.1 を1つのスクリプトで入れ、`pnpm run secrets:scan` で履歴全体をスキャンし、CI で失敗させる

**Independent Test**: quickstart.md の2章

（US1 と独立しているので、Phase 3 と並行してよい）

- [ ] T013 [P] [US4] `scripts/install-gitleaks.sh` を作る（research R10）: `GITLEAKS_VERSION=8.30.1` と `linux_x64`・`linux_arm64` の SHA-256 を定数に持つ。`uname -m`（`x86_64`→`x64`、`aarch64`→`arm64`、それ以外は失敗）で選び、`/usr/local/bin/gitleaks version` が同じ版なら何もせず 0。違えば `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_${ARCH}.tar.gz` を一時ディレクトリに取り、`sha256sum -c` で確かめて、一致しなければ消して失敗する。一致したら `install -m 0755` で `/usr/local/bin/gitleaks` に置く（root でなければ `sudo`）。SHA-256 は Workshop で公式の `gitleaks_8.30.1_checksums.txt` から写す（このクラウドの作業環境からは github.com に届かないため） （**残り**: SHA-256 が空。クラウドの作業環境から github.com のリリースに届かないため、Workshop で写す。スクリプトは空なら止まる）
- [X] T014 [P] [US4] `.gitleaks.toml` を作る: `[extend] useDefault = true`。research R10 の4件を、1件ずつ `[[allowlists]]` に `description`（なぜ偽の値か）・`paths`（そのファイル1つの正規表現）・`regexes`（その偽の値だけに当たる正規表現）・`condition = "AND"` で書く（data-model.md の GitleaksAllowlist）。規則全体やディレクトリ全体を除外しない
- [ ] T015 [US4] `.workshop/devtools/hooks/setup-base` の apt に `shellcheck` を足し、`scripts/install-gitleaks.sh` を呼ぶ。`workshop refresh dev` で、フックの実行時に `/project` が見えるかを確かめ、見えなければスクリプトの内容を読める場所（フックの隣への複製は避け、`workshop` の仕組みで渡せる方法）を調べて合わせる。結果を journal に書く （**残り**: setup-base は書いた。Workshop の `workshop refresh dev` での確認が残る）
- [X] T016 [US4] `.github/workflows/ci.yml` を直す: `actions/checkout` に `fetch-depth: 0`、`corepack enable` のあとに `sudo bash scripts/install-gitleaks.sh`、`pnpm run check` のあとに `pnpm run secrets:scan`（contracts/commands.md）
- [ ] T017 [US4] Workshop で `pnpm run secrets:scan` が 0 で終わることと、quickstart.md の2章の失敗の確認（偽の `ghp_` トークン）で 1 になることを確かめる。CI でも、偽の値を含むブランチを push して赤になることを1回確かめ、そのブランチを消す。結果（所要時間を含む）を journal に書く （**残り**: ローカルの確認は Docker Hub のイメージで済み〔履歴全体 no leaks、偽のトークンで 1〕。Workshop の本物の gitleaks と、CI が赤になる確認が残る）

**Checkpoint**: ローカルと CI の `secrets:scan` が通り、偽のトークンで失敗する

---

## Phase 5: User Story 3 - Caddy で factory とステージングを公開する (Priority: P1)

**Goal**: 1つの Caddyfile で本番と予行演習を切り替え、ファクトリーの3パスとステージングを転送する

**Independent Test**: `pnpm run deploy:lint` の Caddy の部分と、quickstart.md の4章の 4〜8

- [X] T018 [P] [US3] `deploy/Caddyfile` を contracts/caddy.md のとおりに作る（`{$FACTORY_DOMAIN}`・`{$STAGING_DOMAIN}`・`tls {$CADDY_TLS}`、`@factory path /healthz /webhook /status` → `127.0.0.1:8787`、ほかは `respond 404`、ステージングは `127.0.0.1:3100`）。先頭に、ポートの決まり（8787 は `factory.toml` の `[http].port`、3100 は 010 のデモアプリ）を日本語のコメントで書く
- [X] T019 [P] [US3] `deploy/caddy.env.example`（`FACTORY_DOMAIN=`・`STAGING_DOMAIN=`・`CADDY_TLS=`、値は空、各行に説明のコメント）と `deploy/systemd/caddy.service.d/sakura-factory.conf`（`[Service]` `EnvironmentFile=/etc/caddy/caddy.env`）を作る（contracts/systemd.md）
- [X] T020 [US3] `deploy/scripts/lint.sh` に Caddy の検査を書く: `docker` がなければ「Docker が必要です」で失敗。`docker run --rm -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" -e FACTORY_DOMAIN=factory.test -e STAGING_DOMAIN=staging.test -e CADDY_TLS=internal caddy:2.11.9 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` と `caddy fmt --diff /etc/caddy/Caddyfile`（差があれば失敗）。`pnpm run deploy:lint` で通ることを確かめる

---

## Phase 6: User Story 2 - 手順書を上から流して VPS に配備する (Priority: P1)

**Goal**: `setup.sh` と `update.sh` と手順書で、初期状態の Ubuntu からファクトリーの常駐と公開まで到達する

**Independent Test**: Phase 7 の予行演習（quickstart.md の4章）

- [X] T021 [P] [US2] `deploy/systemd/factory.service` を contracts/systemd.md のとおりに作る（`User=factory`・`SupplementaryGroups=docker`・`EnvironmentFile=/etc/sakura-factory/factory.env`・`Environment=FACTORY_CONFIG=/etc/sakura-factory/factory.toml`・`ExecStart=/opt/node/bin/node src/main.ts`・`Restart=on-failure`・`RestartSec=5`・`StartLimitIntervalSec=300`・`StartLimitBurst=5`・`TimeoutStopSec=70`・`StateDirectory=sakura-factory` と保護設定の一式）。各設定の理由を日本語のコメントで書く
- [X] T022 [P] [US2] `deploy/factory.env.example` を作る（`SAKURA_AI_API_KEY=` は空。007 で足す GitHub App の変数はコメントで場所だけ示す。「このファイルは root:factory 0640」と書く）
- [X] T023 [US2] `deploy/scripts/lint.sh` に、shellcheck（`deploy/**/*.sh` と `scripts/*.sh`）と systemd の検査を足す: `deploy/systemd/factory.service` を一時ファイルに写し、`ExecStart=/opt/node/bin/node` を `ExecStart=/bin/true` に置き換えて `systemd-analyze verify` を実行し、終了コードが 0 でも出力が1行でもあれば失敗にする（research R14。知らない設定名は警告だけになるため）。drop-in は `[Service]` と `EnvironmentFile=` だけであることを `grep` で確かめる。T020 の Caddy の検査と合わせ、最後に各検査の `ok` を出す
- [X] T024 [US2] `deploy/scripts/update.sh` を contracts/deploy.md の表のとおりに作る（`lib.sh` を読む。引数 `ref` の既定は `origin/main`。手順は「取得」「チェックアウト」「依存」「作業場のイメージ」「マイグレーション」「再起動」「生存確認」「版の表示」。`pnpm` は `/opt/node/bin` を PATH の先頭にして corepack 経由で呼ぶ。生存確認は `curl -fsS http://127.0.0.1:8787/healthz` を 1 秒おきに 30 回、失敗なら `journalctl -u factory -n 50 --no-pager` を出して `die`）
- [X] T025 [US2] `deploy/scripts/setup.sh` を contracts/deploy.md の手順 1〜10 のとおりに作る。要点: root でなければ失敗。Node は `https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz` と `SHASUMS256.txt` を取り、該当行で `sha256sum -c`。Caddy は公式の手順（`https://dl.cloudsmith.io/public/caddy/stable/gpg.key` を `/usr/share/keyrings/caddy-stable-archive-keyring.gpg` に、`debian.deb.txt` を `/etc/apt/sources.list.d/caddy-stable.list` に）で入れ、`apt-get install caddy=2.11.9` と `apt-mark hold caddy`。`factory` は `useradd --system --home-dir /var/lib/sakura-factory --shell /usr/sbin/nologin --groups docker`（あれば `usermod -aG docker`）。`factory.toml` は初回だけ、リポジトリの `factory.toml` を写して `[storage]` の2行を `/var/lib/sakura-factory/...` に置き換える（contracts/factory-toml.md）。`factory.env`・`caddy.env` がなければひな形を `root:factory`／`root:caddy`・`0640` で写し、「値を書いてから setup.sh を流し直してください」で `die`。あれば所有者と権限が違えば `die`、空の必須変数（`SAKURA_AI_API_KEY`・`FACTORY_DOMAIN`・`STAGING_DOMAIN`・`CADDY_TLS`）があれば `die`。ufw は `default deny incoming`・`allow 22/tcp`・`80/tcp`・`443/tcp`・`--force enable`。SSH は `FACTORY_SKIP_SSH=1` でなければ、`/root/.ssh/authorized_keys` か sudo できるユーザーの `authorized_keys` に鍵が1つ以上あるのを確かめてから `/etc/ssh/sshd_config.d/01-sakura-factory.conf`（`PasswordAuthentication no`・`PermitRootLogin prohibit-password`。cloud-init の `50-cloud-init.conf` より先に読まれる名前）を置き、`sshd -t` と `sshd -T` で実際に効く値を確かめたあと `systemctl reload ssh`。最後に `update.sh "$FACTORY_REF"`
- [X] T026 [US2] `deploy/README.md`（手順書）を contracts/deploy.md の「手順書」の7節で書く。各手順に実行するコマンドと「期待する出力」を書き、`setup.sh` の手順名を見出しに使う。冒頭に「推論を国産・ZDRで閉じる」構成の中で VPS が担う役割を1段落で書く（「国産インフラで完結」とは書かない）。ドメインは `factory.example.jp` のような例示だけにする

---

## Phase 7: User Story 5 - 配備の手順をローカルで予行演習する (Priority: P2)

**Goal**: `pnpm run deploy:rehearsal` 1つで、本番と同じ `setup.sh` を systemd 付きの Ubuntu コンテナに流して確かめ、片付ける

**Independent Test**: quickstart.md の4章

- [X] T027 [P] [US5] `deploy/rehearsal/Dockerfile` を作る: `ubuntu:24.04` に `systemd systemd-sysv dbus iproute2 python3 curl ca-certificates git sudo openssh-server` を入れ、`STOPSIGNAL SIGRTMIN+3`、`CMD ["/sbin/init"]`。ラベル `sakura-factory.rehearsal=1`
- [X] T028 [US5] `deploy/rehearsal/run.sh` を作る: `trap` で成功・失敗とも、ラベル `sakura-factory.rehearsal=1` のコンテナ・ボリューム・ネットワークを消す。手順は、イメージのビルド → `git bundle create` で HEAD を一時ファイルに → `docker run -d --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock`（cgroup v1 のホストでも動く組み合わせを実装のときに確かめ、journal に書く）とボリューム（コンテナの `/var/lib/docker`、ラベル付き）で起動 → systemd が `running`／`degraded` になるまで待つ → bundle と `deploy/scripts`・`scripts/install-gitleaks.sh` が入ったリポジトリを `docker cp` → `127.0.0.1:3100` で応答する仮のアプリ（`python3 -m http.server 3100` を systemd-run で）→ quickstart.md の4章の 1〜17 を順に実行し、各項目で `ok`／`NG <項目>` を出す（`FACTORY_REPO_URL=<bundle のパス>`、`FACTORY_SKIP_SSH=1`、偽の `SAKURA_AI_API_KEY`、`CADDY_TLS=internal`、`factory.test`・`staging.test`）。12 は `sqlite3 /var/lib/sakura-factory/factory.db .dump | sha256sum` を比べる。全体の所要時間を最後に出す
- [ ] T029 [US5] Workshop（または開発機の Docker）で `pnpm run deploy:rehearsal` を通す。通らなかった手順は `setup.sh`・`update.sh`・ユニットを直して流し直す。失敗と直し方、所要時間を journal に書く。終わったあと、ラベル付きのコンテナ・ボリュームが残っていないことを確かめる （**残り**: クラウドの作業環境で、Caddy・gitleaks・作業場のイメージを代用して全項目が通った〔journal 参照〕。代用なしの Workshop での実行が残る）

**Checkpoint**: 予行演習が 15 分以内に全項目 `ok` で終わり、何も残らない

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T030 [P] `.github/workflows/ci.yml` に `pnpm run deploy:lint` を足す（`secrets:scan` のあと）。ランナーに `shellcheck`・`systemd-analyze`・Docker があることを CI の結果で確かめる
- [X] T031 [P] `docs/design/03` の5章（ランタイム・基盤・サンドボックス・開発ツール・運用）と8章、`docs/実装計画.md` 3章の gitleaks の行を、plan.md の「設計ドキュメントとの差分」どおりに直す
- [X] T032 [P] `docs/journal/2026-11-11-006-vps-ops.md`（実装の記録。日付は実装した日）に、実装中に確かめたこと（gitleaks の GitHub のリリースの最新版とチェックサム、Workshop のフックで `/project` が見えたか、予行演習の cgroup・ufw・Docker の挙動、所要時間）を書く。spec・plan の段階で分かった事実は `docs/journal/2026-11-11-006-vps-ops-specとplan.md` にあるので繰り返さない
- [X] T033 `pnpm run check`・`pnpm run secrets:scan`・`pnpm run deploy:lint` を通す。`git grep -nE 'example\.jp|\.test\b'` などで、ドメインの例示（`factory.example.jp`・`factory.test`）以外のドメインが配備物と手順書にないことを確かめる（SC-006）。spec の SC-001〜SC-008 を1つずつ、どのタスクの結果で確かめたかを journal にまとめる

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3（US1）→ Phase 5（US3）・Phase 6（US2）→ Phase 7（US5）→ Phase 8
- Phase 4（US4）は Phase 1 のあといつでも並行できる。ただし T025（`setup.sh`）は T013（`install-gitleaks.sh`）を呼ぶ
- T020（Caddy の検査）と T023（shellcheck・systemd の検査）は同じ `lint.sh` を書くので、T020 → T023 の順
- T024（`update.sh`）は T011（常駐）と T021（ユニット）のあと。T025 は T024 のあと
- T030（CI に `deploy:lint`）は T023 のあと。T016（CI に gitleaks）と同じファイルなので T016 → T030 の順

### Parallel Opportunities

- Phase 1: T002・T003
- US1: T006・T007（テスト）
- US4 全体（T013・T014）は US1 と並行
- US3: T018・T019
- US2: T021・T022
- Phase 8: T031・T032

## Parallel Example: User Story 1

```text
Task: "T006 src/http/app.test.ts を書く"
Task: "T007 src/http/server.test.ts を書く"
```

## Implementation Strategy

### MVP First

1. Phase 1・2 → Phase 3（US1）で `pnpm start` が常駐して `/healthz` に応答する。ここで止めても、007（`/webhook`）と 011（`/status`）が乗る土台になる

### Incremental Delivery

1. US1 → US4（gitleaks。008 の前提を早く満たす）
2. US3（Caddy）→ US2（systemd・スクリプト・手順書）
3. US5（予行演習）で、解禁の日の手順を通しで確かめる
4. Polish（CI・設計ドキュメント・journal）
