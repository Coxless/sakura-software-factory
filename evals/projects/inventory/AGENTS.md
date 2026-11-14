# AGENTS.md

小さな在庫計算のライブラリ（TypeScript、依存なし。Node.js 24 で `.ts` を直接実行する）。

## コマンド

- テスト: `node --test "test/**/*.test.ts"`（`node:test` と `node:assert/strict`）
- lint: `node scripts/lint.ts`（`console.log` と `any` を禁止）

## 決まり

- import は `.ts` を付けた相対パスで書く
- 公開する関数は `src/index.ts` から export する
- テストは `test/` に `<名前>.test.ts` で置く
- `.eval/` には触らない
