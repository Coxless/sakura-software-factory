# 005 local-pipeline の実装

計画役・工程内テスト・検査役・やり直しのループと、`pnpm run pipeline:dev` を実装した。自動テストは 42 ファイル・519 件が通った（Docker を使うものを含む）。

## drizzle-kit が作ったマイグレーションがそのままでは動かなかった

`agent_runs` に `verdict` 列を足すため `pnpm run db:generate --name agent_runs_verdict` を実行した。SQLite では列の CHECK を足せないので、drizzle-kit は「新しい表を作る → `INSERT ... SELECT` で写す → 古い表を消す」の形の SQL を出した。ところが SELECT 側に、古い表にはない `"verdict"` が入っていた。

```sql
INSERT INTO `__new_agent_runs`(..., "error", "verdict", "trace_path", ...)
  SELECT ..., "error", "verdict", "trace_path", ... FROM `agent_runs`;
```

0002 まで当てた DB に 0003 を当てると、次のエラーで止まる（行が0件でも止まる）。

```
SqliteError: no such column: "verdict" - should this be a string literal in single-quotes?
```

SQLite は本来、二重引用符の未知の識別子を文字列リテラルとして扱う（古い互換のための動き）。better-sqlite3 はこの扱いを無効にしてビルドされているので、文字列にならずにエラーになる。無効になっていなければ、文字列 `'verdict'` が入って CHECK（`verdict IN ('pass','fail')`）に違反していたはず。

SELECT 側の `"verdict"` を `NULL` に手で直した（`drizzle/0003_agent_runs_verdict.sql`）。直したあとは、0002 の状態で `agent_runs` に行を入れてから 0003 を当てても通り、既存の行の `verdict` は NULL になる。テストの `migratedMemoryDb` は空の DB に全部を当てるので、この問題は自動テストでは見つからない。列を足すマイグレーションを作ったら、生成された SELECT を目で見ることにする。

## 工程内テストを「完了の時点」で走らせる

Pi 1.5.0 の `finishTurn` は `async` にでき、signal も受け取れる。004 の実装工程に `onComplete(signal)` を足し、「ツールを呼ばず、差し込みもない」ターンの終わりで await する。文字列が返れば `steer` して `{ action: "continue" }`、`undefined` なら完了。これで、テストの最中に期限が来ると、テストのコマンド（作業場の `exec`）まで打ち切られる（`run.test.ts` の期限のテストで、`exec` に渡した signal が中止されることを確かめた）。

テストのコマンドを起動できない（終了コード 126・127、作業場の異常）ときは、`onComplete` から例外を投げる。実装工程はこれを `failed` として返すので、工程全体も `failed` になり、判定には進まない。

## 開発用の LLM で手動の確認（Google AI Studio）

- 対象: このリポジトリ（公開してよいデータ）。HEAD は `c0f5c5e`（005 のコードはまだコミットしていない状態の複製）
- Issue: 「`src/trace/mask.test.ts` に、`maskSecrets` に空文字列を渡すと空文字列が返るテストを1件足す。`mask.ts` は変えない」
- コマンド: `FACTORY_CONFIG=factory.dev.toml pnpm run pipeline:dev -- --repo /project --issue <file> --install "pnpm install --frozen-lockfile" --max-turns 15 --timeout-minutes 15`
- モデル: 計画役・実装役 `gemini-3.5-flash-lite`、検査役 `gemma-4-26b-a4b-it`

| 回 | 結果 | リクエスト | 所要時間 | 内訳 |
|---|---|---|---|---|
| 1回目（job 2） | `failed`（判定できない） | 12 | 112 秒 | 計画 1（13.2 秒、1回で形が合った）→ 実装 8 ターン（ツール 7 回）→ `pnpm run check` 成功（15.8 秒）→ 判定で gemma-4 が 500 を3回（ゲートの再試行の上限） |
| 2回目（job 3） | `passed` | 11 | 92 秒 | 計画 1（1.7 秒）→ 実装 9 ターン（ツール 8 回）→ `pnpm run check` 成功（15.6 秒）→ 判定 1（19.2 秒、1回で形が合い `pass`） |

- 計画役も検査役も、プロンプトだけで JSON の形を守った（再要求 0 回）。どちらもコードブロックの囲みなしで返した
- 実装役が足したテストは Issue どおりの4行（`+4 -0`）で、`mask.ts` は変えていない。検査役もそれを理由に挙げて合格にした
- `llm_calls` の件数と結果の `requests` は、2回とも一致した（1回目は再試行の3件を含めて 12）
- 1回目の 500 は、1回目の要求から3回続けて即座に（622〜850 ms）返った。11-10 にも gemma-4 で 500 が続いたことがある。2回目は同じ大きさの入力で通ったので、入力の中身よりも提供元の一時的な不調に見える

## まだ分かっていないこと

- gemma-4 の 500 がどのくらいの割合で起きるか。続くなら、開発用の検査役を `gemma-4-31b-it` に替えるか、判定だけゲートの再試行の上限を上げるかを考える（本番の検査役は さくらの Qwen3.6 なので、開発中だけの問題）
- 工程内テストで失敗を差し込む流れ（`testing → implementing`）は、自動テストと Docker のテストでは確かめたが、実際のモデルではまだ起きていない（2回とも1回目で通った）
