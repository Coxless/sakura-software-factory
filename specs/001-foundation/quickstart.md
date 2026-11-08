# Quickstart: 基盤（foundation）の動作確認

001 が仕様どおりに動くことを、手で確かめる手順。コマンドはすべてホストから Workshop の中で実行する。

## 前提

```bash
workshop start dev          # 初回は workshop launch dev
alias w='workshop exec dev --'
w bash -c 'cd /project && corepack enable && pnpm install --frozen-lockfile'
```

以下 `w bash -c 'cd /project && …'` は `…` の部分だけを書く。

## 1. 品質チェック（US1 / SC-001・SC-002）

```bash
time pnpm run check
```

期待: 終了コード 0、2分以内。

失敗を検出できることを確かめる（確かめたら元に戻す）:

| 入れる誤り | 期待 |
|---|---|
| `src/` のファイルに `const x: number = "a";` | `tsc` の段で失敗し、ファイルと行が出る |
| 未使用の変数・フォーマット崩れ | `biome ci` の段で失敗する |
| `expect(1).toBe(2)` のテスト | `vitest` の段で失敗し、テスト名が出る |

`npm install` を実行すると、`devEngines.packageManager` の指定により 0 以外の終了コードで失敗し、pnpm を使うよう示される。

## 2. 設定の検証（US2 / SC-003）

```bash
pnpm start                                   # 同梱の factory.toml で起動処理が通る
FACTORY_CONFIG=/nonexistent.toml pnpm start  # パスを示して終了コード 1
```

誤った設定での確認は自動テスト（`src/config.test.ts`）にまとめてある。表は [contracts/factory-toml.md](./contracts/factory-toml.md) の「検証エラーの形」。

| ケース | 期待 |
|---|---|
| `[models] implementer` を消す | `/models/implementer` 必須エラー |
| `monthly_requests = "3000"` | 型エラー |
| `per_job_requests` > `monthly_requests` | 範囲エラー |
| `[llm] api_key = "x"` | 未知の項目エラー＋環境変数の案内 |
| `timezone = "Mars/Base"` | タイムゾーンのエラー |
| TOML の構文を壊す | 行・列付きのエラー |

## 3. 記録先とマイグレーション（US3 / SC-004・SC-005）

```bash
rm -rf data && pnpm run db:migrate           # data/factory.db ができる
pnpm run db:migrate                          # 2回目も成功し、何も変わらない
sqlite3 data/factory.db '.tables'            # budget deployments job_events jobs llm_calls（と drizzle の管理テーブル）
sqlite3 data/factory.db 'PRAGMA journal_mode' # wal
```

`sqlite3` CLI が Workshop にない場合は、`node -e` で better-sqlite3 から同じ問い合わせをする。

書き込み・読み出し・集計・二重取り出し防止・1,000件での集計時間は自動テスト（`src/queue/*.test.ts`）で確かめる。テーブルの形は [data-model.md](./data-model.md)。

## 4. ログ（US4 / SC-006）

```bash
pnpm start | head -5                          # 1行1件の JSON（time, level, msg）
pnpm start | pnpm exec pino-pretty            # 読みやすい表示
```

秘密情報が伏せられることは `src/log.test.ts` で確かめる（`authorization` などの項目名と、`ghp_…` などの値の両方）。

## 完了の判断

- `pnpm run check` が通る（ここに全自動テストが含まれる）
- 上の 1〜4 の手作業の確認が期待どおり
- CI（GitHub Actions）で同じ `pnpm run check` が通る
