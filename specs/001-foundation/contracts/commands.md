# Contract: 開発・運用コマンド

`package.json` の scripts。ローカルでは Workshop の中で実行する（`workshop exec dev -- pnpm run <name>`）。

| コマンド | 中身 | 成功 | 失敗 |
|---|---|---|---|
| `pnpm run check` | `biome ci . && tsc --noEmit && vitest run` | 終了コード 0 | 最初に失敗した段の終了コード（0 以外）。場所・テスト名を出力する |
| `pnpm run fix` | `biome check --write .` | ファイルを直す | — |
| `pnpm run lint` | `biome ci .` | | |
| `pnpm run typecheck` | `tsc --noEmit` | | |
| `pnpm test` | `vitest run` | | |
| `pnpm start` | `node src/main.ts` | 設定の読み込み → ログの準備 → マイグレーションの適用を終え、`factory started` を出す | 設定・マイグレーションのエラーを出し、終了コード 1 |
| `pnpm run db:generate` | `drizzle-kit generate` | `src/queue/schema.ts` の変更から `drizzle/` に SQL を作る（開発者だけが使う） | |
| `pnpm run db:migrate` | `node src/migrate.ts` | 未適用のマイグレーションを適用して終了コード 0。適用済みなら何もせず 0 | 終了コード 1、データベースは適用前のまま |

- CI（`.github/workflows/ci.yml`）は GitHub のランナーで直接、`pnpm install --frozen-lockfile` → `pnpm run sandbox:build`（003）→ `pnpm run check` を呼ぶ。`pnpm run check` には `FACTORY_SANDBOX_REQUIRED=1` を渡し、作業場のテストを飛ばさない
- 001 の `pnpm start` は起動処理を終えたらそのまま終了する。常駐（HTTP と Worker）は 006・007 で足す
