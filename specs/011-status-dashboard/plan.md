# Implementation Plan: 計測と状況ページ（status-dashboard）

**Branch**: `011-status-dashboard` | **Date**: 2026-11-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/011-status-dashboard/spec.md`

## Summary

`GET /status` で、今月の消費・成功率・平均処理時間・CI 初回通過率・デプロイ成功率と、最近のジョブ・工程の実行・デプロイを出す。内容は5つ。

1. **集計**（`src/status/collect.ts`）: 002〜010 の記録（`llm_calls`・`jobs`・`job_events`・`agent_runs`・`deployments`・`budget`）を読むだけで、状況の要約（`StatusSnapshot`）を作る。月の区切りは予算ゲートと同じ `monthRange`。新しい表・列・マイグレーションは足さない
2. **形式**（`src/status/schema.ts`・`src/status/render.ts`）: JSON のスキーマは TypeBox で決め、テストでその形に合うことを確かめる。HTML は hono/html の `html` タグ（値を自動でエスケープする）で組み立て、スクリプトなし・外部の読み込みなし
3. **ルート**（`src/http/app.ts`）: `GET /status`（`?format=json` で JSON）。キャッシュ禁止・埋め込み禁止・CSP（スクリプトを許さない）の見出しを付ける。DB が読めなければ 500（本文は `{"error":"internal_error"}` と同じ形）
4. **開発用の CLI**（`src/status-dev.ts`）: `pnpm run status:dev` で、設定の DB（既定は `factory.dev.toml`）を読み取り専用で開き、同じ集計を JSON（`--html` で HTML）で標準出力に出す。常駐のファクトリーは開発用の設定では起動しないため（原則 I）
5. **認証**（`deploy/Caddyfile` ほか）: Caddy の `basic_auth` で `/status` だけを守る。利用者名とパスワードのハッシュ（bcrypt）は `/etc/caddy/caddy.env` に置き、`setup.sh` は空なら止まる。予行演習（`deploy:rehearsal`）に「認証なしで 401・正しい認証で 200」を足す

## Technical Context

**Language/Version**: TypeScript 7.0.2（型チェックだけ）、Node.js 24 LTS（型除去で実行）

**Primary Dependencies**: 既存のまま（Hono 4.13.17 の `hono/html`、Drizzle、better-sqlite3、TypeBox 1.4.5）。新しい npm の依存は足さない。Caddy 2.11.9 の `basic_auth`

**Storage**: 001 の SQLite を読むだけ。マイグレーションなし

**Testing**: Vitest。`:memory:` の DB にマイグレーションを当て、決まった記録を入れて集計値を確かめる。`app.request()` で `/status` を取得して見出し・本文・目印の文字列が出ないことを確かめる。Caddy は `deploy:lint`（`caddy validate`）と `deploy:rehearsal`（401・200）

**Target Platform**: Linux（さくらのVPS。開発は Ubuntu Workshop `dev`）

**Project Type**: 常駐サービス（単一プロジェクト）

**Performance Goals**: 1か月分の記録（ジョブ数百件・LLM 呼び出し 3,000 件）で 1 秒以内（SC-003）

**Constraints**: LLM を呼ばない、DB に書かない。依頼の本文・エラー文・軌跡の場所を出さない。認証は Caddy で行い、ファクトリー本体はループバックのまま

**Scale/Scope**: 利用者は運用者1人。開く回数は1日に数回

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 本機能での扱い | 判定 |
|---|---|---|
| I. 推論を国産・ZDRで閉じる | LLM を呼ばない | ✅ |
| II. 工程はコードで制御する | 状態機械に触れない。読むだけ | ✅ |
| III. 実装と検査を別モデルにする | 触れない | ✅ |
| IV. 隔離と最小権限 | 公開のドメインでは Basic 認証（bcrypt のハッシュだけを置く）。認証があっても依頼の本文・エラー文・軌跡は出さない。HTML はエスケープし、CSP でスクリプトを止める | ✅ |
| V. 予算ゲートと計測 | `03` 7章の5つの数値を `llm_calls`・`jobs`・`job_events`・`deployments` から出す。工程の実行の要約（`agent_runs`）を見られるようにする | ✅ |
| VI. 品質ゲートと自律レベルB | 触れない | ✅ |
| VII. シンプルさと差し替え可能性 | 新しい表・依存・ミドルウェアを足さない。集計は要求のたびに SQL で行い、保存しない。GitHub に触れない | ✅ |
| 技術的制約 | Hono・Drizzle・TypeBox | ✅ |
| 開発ワークフロー | テストは `:memory:` の DB だけで、LLM・GitHub を呼ばない | ✅ |

**Post-design re-check**（Phase 1 のあと）: contracts・data-model を見直した。違反はない。

## Project Structure

### Documentation (this feature)

```text
specs/011-status-dashboard/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-status.md   # GET /status の応答（HTML・JSON・見出し・エラー）
│   └── caddy.md         # basic_auth と caddy.env の追加
└── tasks.md             # /speckit-tasks で作る
```

### Source Code (repository root)

```text
.
├── deploy/
│   ├── Caddyfile                 # /status に basic_auth
│   ├── caddy.env.example         # STATUS_USER・STATUS_PASSWORD_HASH
│   ├── README.md                 # 状況ページの節（ハッシュの作り方・確かめ方）
│   ├── scripts/setup.sh          # caddy.env の必須の変数を足す
│   ├── scripts/lint.sh           # caddy validate に偽の認証情報を渡す
│   └── rehearsal/run.sh          # 401・200 の確認
└── src/
    ├── main.ts                   # createApp に db と config を渡す
    ├── status-dev.ts             # pnpm run status:dev（開発用の DB の集計を JSON / HTML で出す）+ status-dev.test.ts
    ├── http/app.ts               # GET /status + app.test.ts
    └── status/                   # 新規
        ├── collect.ts            # 集計 + collect.test.ts
        ├── schema.ts             # StatusSnapshot（TypeBox）
        ├── render.ts             # HTML + render.test.ts
        └── testing.ts            # テスト用の記録の作り方
```

**Structure Decision**: 集計と表示は HTTP と分けて `src/status/` に置く（`03` 8章の `http/app.ts` には「ルートの定義だけ」を残す）。集計は `Db` を受ける関数にし、HTTP なしでテストできるようにする。

## 設計ドキュメントとの差分

同じ変更で直す。

- `03` 5章（ランタイム・基盤）: 公開するパスの行に「`/status` は Caddy の Basic 認証」を足す。ドメイン・TLS の行に認証の値の置き場所を足す
- `03` 7章: `/status` の各数値の定義（成功＝`deployed`、期間は今月、CI 初回通過率の数え方、ジョブ以外の呼び出しも消費に入れる）と、出さないもの・認証を足す
- `03` 8章: `src/status/` を足し、`http/app.ts` の「後で status」を直す
- `specs/006-vps-ops/contracts/caddy.md`: 環境変数と Caddyfile を今の形に合わせる（011 の contracts/caddy.md を正にし、006 側に追記）
- `deploy/README.md`: 状況ページの節

## Complexity Tracking

違反はない。
