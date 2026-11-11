# Implementation Plan: VPS配備と秘密情報スキャン（vps-ops）

**Branch**: `006-vps-ops` | **Date**: 2026-11-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-vps-ops/spec.md`

## Summary

VPS解禁の日（2026-12-03）に手順書を上から流すだけで配備できるように、配備物と予行演習を用意し、008 の前提として gitleaks を入れる。内容は5つ。

1. **常駐プロセスと `/healthz`**: `main.ts` を、マイグレーションのあと Hono で待ち受けて停止の合図まで動く形にする。`/healthz` はデータベースに `SELECT 1` を実行して `200`／`503` を返す
2. **systemd**: `factory` ユーザー（`docker` グループ）で動かすユニット。保護設定・自動再起動・journald
3. **Caddy**: ファクトリーのドメイン（`/healthz`・`/webhook`・`/status` だけ）とステージングのドメイン（`127.0.0.1:3100`）を転送。ドメインと TLS は環境変数で与える
4. **配備スクリプトと手順書・予行演習**: `setup.sh`（冪等）・`update.sh`・手順書。ローカルの Docker で systemd 付きの Ubuntu を立てて同じスクリプトを流す予行演習
5. **gitleaks**: 版とチェックサムを1つのスクリプトに持ち、Workshop・CI・VPS で同じものを入れる。`pnpm run secrets:scan` で履歴全体をスキャンし、テスト用の偽の値は個別に許可する

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行。VPS は v24.22.2 を固定）、bash（配備スクリプト）

**Primary Dependencies**: 001〜004 の依存に加えて hono 4.13.17・@hono/node-server 2.1.6（完全固定）。VPS: Caddy 2.11.9、gitleaks 8.30.1、Ubuntu 24.04 の docker.io・docker-compose-v2・ufw・shellcheck

**Storage**: 001 の SQLite（変更なし）。VPS では `/var/lib/sakura-factory`

**Testing**: Vitest（`/healthz`・停止処理・`[http]` の設定）。配備物は `pnpm run deploy:lint`（shellcheck・systemd-analyze・caddy validate）と、手で実行する `pnpm run deploy:rehearsal`

**Target Platform**: さくらのVPS（Ubuntu 24.04 LTS、x86_64）。開発は Ubuntu Workshop `dev`

**Project Type**: 常駐サービス（単一プロジェクト）＋配備物

**Performance Goals**: `/healthz` が 100ms 以内（SC-005）、停止が 10 秒以内（SC-004）、強制終了から 30 秒以内に復帰（SC-003）、予行演習が 15 分以内（SC-001）

**Constraints**: 秘密情報とドメインの実値をリポジトリに書かない。ファクトリーのポートは外から直接届かない。データベースを更新・再配備で消さない

**Scale/Scope**: VPS 1台。ファクトリー1プロセス、Caddy、作業場、ステージング（010）が同居する

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | LLM を呼ばない。常駐プロセスは開発用の提供元では起動しない（既存の `assertProductionProvider` を保つ）。手順書の表現は「推論を国産・ZDRで閉じる」に従う | ✅ |
| II. 工程はコードで制御する | 工程は扱わない | ✅ |
| III. 実装と検査を別モデルにする | 扱わない | ✅ |
| IV. 隔離と最小権限 | ファクトリーは専用の非 root ユーザー・systemd の保護設定。秘密情報は `0640` のファイルからだけ渡し、作業場には渡さない（003 のまま）。外から届くのは 22/80/443 だけ。IV の MUST（ループはホスト、ツールは隔離した作業場、秘密情報を作業場に渡さない、作業場の隔離設定）はすべて守る。`docker` グループが実質的に root に近いことは、IV の違反ではなく残るリスクとして Complexity Tracking に書く | ✅ |
| V. 予算ゲートと計測 | `/healthz` は LLM を呼ばず、予算を消費しない | ✅ |
| VI. 品質ゲートと自律レベルB | gitleaks を入れ、008 の自動マージ条件の前提を作る。本番デプロイの権限は持たせない（ステージングの転送先だけ用意する） | ✅ |
| VII. シンプルさと差し替え可能性 | 新しいミドルウェアなし。Hono は constitution の主要ライブラリ。配備は bash のスクリプトと systemd だけ（Ansible などを入れない） | ✅ |
| 技術的制約 | Hono・Caddy・systemd は constitution のとおり。pnpm は corepack。TypeBox で `[http]` を検証 | ✅ |
| 開発ワークフロー | ツールの追加は `setup-base`（gitleaks・shellcheck）。CI とローカルで同じコマンド（`secrets:scan`・`deploy:lint`） | ✅ |

**Post-design re-check**（Phase 1 のあと）: contracts・data-model を見直した。違反はない。`docker` グループの残るリスクは Complexity Tracking のとおり（原則 IV は NON-NEGOTIABLE なので、違反としては扱わない）。

## Project Structure

### Documentation (this feature)

```text
specs/006-vps-ops/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── factory-toml.md   # [http] の追加分
│   ├── http.md           # /healthz と 404、停止処理
│   ├── systemd.md        # factory.service と Caddy の drop-in
│   ├── caddy.md          # Caddyfile と環境変数、ポートの決まり
│   ├── deploy.md         # setup.sh・update.sh・VPS 上のファイル配置
│   └── commands.md       # 追加する pnpm scripts と CI の変更
└── tasks.md              # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── .github/workflows/ci.yml          # fetch-depth: 0、gitleaks を入れて secrets:scan、deploy:lint を追加
├── .gitleaks.toml                    # 既定の規則＋テスト用の偽の値の個別の許可
├── .workshop/devtools/hooks/setup-base  # shellcheck を追加、scripts/install-gitleaks.sh を呼ぶ
├── scripts/
│   └── install-gitleaks.sh           # 版・チェックサムを持つ唯一の場所（Workshop・CI・VPS）
├── deploy/
│   ├── README.md                     # 手順書（VPS解禁の日に上から流す）
│   ├── Caddyfile
│   ├── caddy.env.example             # FACTORY_DOMAIN・STAGING_DOMAIN・CADDY_TLS（値は空）
│   ├── factory.env.example           # SAKURA_AI_API_KEY など（値は空）
│   ├── systemd/
│   │   ├── factory.service
│   │   └── caddy.service.d/sakura-factory.conf   # EnvironmentFile の drop-in
│   ├── scripts/
│   │   ├── lib.sh                    # step・die・バージョンの定数
│   │   ├── setup.sh                  # 初回の配備（冪等）
│   │   ├── update.sh                 # 更新
│   │   └── lint.sh                   # deploy:lint の中身
│   └── rehearsal/
│       ├── Dockerfile                # ubuntu:24.04 + systemd
│       └── run.sh                    # deploy:rehearsal の中身
├── factory.toml                      # [http] を追加
└── src/
    ├── main.ts                       # 常駐（HTTP の待ち受けと停止処理）に変える
    ├── config.ts                     # [http] のスキーマを追加 + config.test.ts
    └── http/
        ├── app.ts                    # Hono アプリ（/healthz、404） + app.test.ts
        └── server.ts                 # 待ち受けと停止処理 + server.test.ts
```

**Structure Decision**: `03` 8章の `http/` と `deploy/` に置く。`deploy/` の中は `03` 8章の案（`factory.service`・`Caddyfile`・`staging/compose.yaml`）を、systemd の drop-in とスクリプトが増えるので `systemd/`・`scripts/`・`rehearsal/` に分ける（`staging/` は 010 で足す）。gitleaks のインストールは Workshop・CI・VPS で共有するので、`deploy/` ではなく `scripts/` に置く。`main.ts` の起動処理（設定 → ログ → マイグレーション）は変えずに、その後ろに待ち受けを足す。

## 設計ドキュメントとの差分

同じ変更で直す。

- `03` 0章・2章: 変更なし（Caddy・systemd・Hono・`/healthz` は既に書いてある）
- `03` 5章 ランタイム・基盤: VPS のディレクトリ（コード `/opt/sakura-factory/app`・設定 `/etc/sakura-factory`・データ `/var/lib/sakura-factory`）、`factory` ユーザーを `docker` グループに入れること、ファクトリーのドメインで公開するパス、ステージングの転送先 `127.0.0.1:3100`、Node・Caddy・gitleaks の版を固定することを足す。作業ディレクトリは `/tmp` に置かない（systemd の `PrivateTmp`）ことをサンドボックスの表に足す
- `03` 5章 開発ツール・運用: 秘密情報スキャン（gitleaks。ローカル・CI・VPS で同じ版）を足す
- `03` 8章: `src/http/`（`app.ts`・`server.ts`）、`deploy/` の中身、`scripts/install-gitleaks.sh`、`.gitleaks.toml` を足す。`.github/workflows/ci.yml` の説明に `secrets:scan`・`deploy:lint` を足す
- `docs/実装計画.md` 3章: 「gitleaks は 008 の前に追加する」を、006 で追加済みの書き方に直す
- constitution の変更は要らない（`docker` グループは原則 IV の範囲内の判断として Complexity Tracking に書く）

## Complexity Tracking

違反はない。原則 IV の MUST の外側で増える複雑さ・リスクを1件記録する。

| 追加する複雑さ・リスク | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| ファクトリーのユーザーを `docker` グループに入れる（Docker を操作できる＝ホストの root に近い） | 作業場（003）とステージング（010）のコンテナを、ファクトリーが自分で起動・破棄する必要がある | rootless Docker: 003 の隔離設定（`--read-only`・`--pids-limit`・cgroup の制限）と `.git` の bind mount の挙動をすべて確かめ直すことになり、締切（12-16）に対して重い。sudo で `docker` だけを許す: 引数を絞れないので権限は同じで、設定だけ増える。軽減策: 専用ユーザー、systemd の保護設定、秘密情報を作業場に渡さない（003）、外から届くのは 22/80/443 だけ、SSH はパスワードなし。gVisor（`runsc`）は任意機能のまま |
