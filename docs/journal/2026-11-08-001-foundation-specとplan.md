# 001 foundation の spec と plan（Spec Kit の初回）

## やろうとしたこと

実装計画（`docs/実装計画.md`）の最初の機能 001 `foundation` を、Spec Kit で specify → clarify → plan まで進める。

## Spec Kit: ブランチが自動で作られなかった

- `/speckit-specify` を実行しても、機能ブランチ（`001-xxx`）が作られなかった
- 原因: ブランチの作成は Spec Kit 本体ではなく **git 拡張** の `before_specify` フックの機能。このリポジトリは git 拡張なしで初期化したため、`.specify/extensions.yml` がなかった
- 後続のコマンド（plan / tasks / implement）は、作業中の機能を `.specify/feature.json` の `feature_directory` から探す。ブランチ名に頼らないので、git 拡張がなくても進められる
- 結論: ブランチは手で `git switch -c 001-foundation` を実行して作った。機能は12個ほどなので、手作業で十分と判断した

## clarify で決めたこと（3問）

| 問い | 決定 | 理由 |
|---|---|---|
| 月の予算の「月初」をどのタイムゾーンで区切るか | JST。設定で変えられる | 運用者も読者も日本時間で考える。さくらの枠のリセット基準が違うと分かったら設定を変える |
| `budget` テーブルに何を持たせるか | 月ごとの「適用した上限の写し」と「受付を止めた時刻」だけ。消費は `llm_calls` から数える | 上限は設定ファイル、消費は呼び出しの記録と、正しい値を1か所ずつにして二重管理を避ける |
| マイグレーションをいつ適用するか | 起動時に自動で適用する。専用コマンドでも実行できる | 配備を「pull して再起動」だけにしたい。適用を忘れる方が危ない |

## バージョンを調べて分かったこと（2026-11-08 時点の npm）

- **TypeBox はパッケージ名が変わっていた。** `@sinclair/typebox` は 0.34.52 で止まっていて、1.x は `typebox`（1.4.6）として公開されている。Pi の `@earendil-works/pi-schema` 1.5.0 の README には「TypeBox 1.x の型の形を読む（TypeBox は import しない）」とあり、devDependencies も `typebox: 1.3.27` だった → 本プロジェクトも `typebox` 1.x にそろえた
- **Pi はもう 1.0 を超えていた。** `@earendil-works/pi-ai` と `pi-agent-core` はどちらも 1.5.0。設計書（`03` 5章）の「1.0 前（0.8x 台）」は古かったので、その場で 1.x の記述に直した。あわせて TypeBox の行にもパッケージ名（`typebox` 1.x）を書いた
- **drizzle の 1.0 は RC のまま。** `latest` は drizzle-orm 0.45.4 / drizzle-kit 0.31.11、`rc` は 1.0.0-rc.5（2026-10-21）。安定版の 0.45 系を使う
- **TypeScript 7（Go 製）が `latest` になっていた。** 7.0.2（2026-07-08）。型チェックにしか使わない（実行は Node 24 の型除去）ので採用した。問題が出たら 6.0 に戻す
- そのほか: pnpm 12.18.0、vitest 5.1.0、@biomejs/biome 2.6.6、pino 10.4.0、better-sqlite3 13.0.3、smol-toml 1.9.1。Workshop の Node は v24.22.2、corepack は 0.36.0

調べ方: `workshop exec dev -- npm view <pkg> version dist-tags time --json`。中身は `npm pack` で取ってきて確かめた。

## analyze で見つかった穴（実装の前に直した）

`/speckit-analyze` で spec・plan・tasks を突き合わせたら、CRITICAL は 0 件だったが、実装中につまずきそうな点が4件あった。

- **ログの伏せ字が浅かった。** 値で伏せる処理を pino の `formatters.log` で「文字列の値」にだけかける計画だったが、それだと `err` の中のメッセージや入れ子の値に入った `ghp_…` が素通りする。しかもテスト（T032）はエラー文が伏せられることを確かめる → 再帰的にたどる形に直した
- **「npm を拒否する」が実は何もしていなかった。** `packageManager` を書くだけでは `npm install` は普通に通る。受入シナリオも「使われる（または拒否される）」と合否が決まらない書き方だった → `devEngines.packageManager`（`onFail: "error"`）で失敗させると決め、実装時に npm が本当に止まるかを確かめるタスクを足した
- **設計書のディレクトリ構成から外れていた。** `log.ts`・`migrate.ts`・`trace/mask.ts` などが `03` 8章にないのに、plan は「03 を直す必要はない」と書いていた → 8章を更新した
- **独立のはずのストーリーが型でつながっていた。** ロガーが設定の型（`FactoryConfig`）を受け取る形だったため、ログ（US4）が設定（US2）に依存していた → ロガーは `{ level }` だけを受け取る形にした

## まだ分かっていないこと

（pnpm 12 の設定キーと `devEngines` の効き目は、実装で確かめた → `2026-11-08-001-foundation-実装.md`）



- さくらのAI Engine のエンドポイント URL と、モデル名の正確な文字列（002 の実機テストで確かめる）
- さくらのAI Engine の無償枠がどのタイムゾーンでリセットされるか
