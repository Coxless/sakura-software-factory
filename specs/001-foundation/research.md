# Research: 基盤（foundation）

技術の選定そのものは constitution と `docs/design/03` 5章で決まっている。ここでは、それを実装に落とすときの未確定事項（バージョン、組み合わせ方、細かな方式）を決める。バージョンは 2026-11-08 に npm レジストリで確認した。

## R1. パッケージのバージョン（すべて完全に固定する）

**Decision**:

| パッケージ | バージョン | 区分 |
|---|---|---|
| pnpm（`packageManager`） | 12.18.0 | — |
| typescript | 7.0.2 | dev |
| @types/node | 24.19.2 | dev |
| @biomejs/biome | 2.6.6 | dev |
| vitest | 5.1.0 | dev |
| drizzle-kit | 0.31.11 | dev |
| pino-pretty | 13.2.0 | dev（ローカルで読みやすく表示するだけ） |
| typebox | 1.4.5 | runtime |
| smol-toml | 1.9.1 | runtime |
| pino | 10.4.0 | runtime |
| better-sqlite3 | 13.0.3 | runtime |
| @types/better-sqlite3 | 9.6.0 | dev |
| drizzle-orm | 0.45.4 | runtime |

`package.json` には `packageManager` に加えて `devEngines.packageManager`（`name: "pnpm"`, `onFail: "error"`）を書き、npm でのインストールを失敗させる（`packageManager` だけでは npm は止まらない）。依存は `^` や `~` を付けずに書き、`pnpm-workspace.yaml`（または `.npmrc`）で `save-exact` を有効にする。

**Rationale**:
- CLAUDE.md の「バージョンを完全に固定する」を Pi 以外にも広げ、24時間稼働中に依存が勝手に変わらないようにする
- TypeScript 7（Go 製のネイティブ実装）は 2026-07 から安定版。型チェックしか使わない（実行は Node の型除去）ので、JavaScript API が要らない本件では速さだけが得になる
- drizzle は 1.0 が RC のため、安定版の 0.45 系を使う

**Alternatives considered**:
- `@sinclair/typebox` 0.34 → 不採用。Pi の `@earendil-works/pi-schema` 1.5.0 は TypeBox 1.x（パッケージ名 `typebox`）の型の形を前提にしている。002 以降でツール定義と同じ TypeBox を使うため、最初から `typebox` 1.x にそろえる
- drizzle-orm 1.0.0-rc.5 → 不採用。RC で API が変わりうる。必要になったら機能単位で上げる
- TypeScript 6.0 → 7 で問題が出たときの退避先として残す（型チェックだけなので入れ替えは `package.json` 1行）

## R2. TypeScript を型除去で実行する設定

**Decision**: Node 24 の型除去（既定で有効）でそのまま `node src/main.ts` を実行する。`tsconfig.json` は型チェック専用とし、次を有効にする。

- `noEmit`, `strict`, `module: nodenext`, `moduleResolution: nodenext`, `target: esnext`
- `erasableSyntaxOnly`（enum・namespace・パラメータプロパティなど、消すだけでは済まない構文を禁止する）
- `verbatimModuleSyntax`（型だけの import は `import type` にする）
- `allowImportingTsExtensions`（相対 import は `./config.ts` のように `.ts` 付きで書く）
- `noUncheckedIndexedAccess`

**Rationale**: ビルド手順をなくし、systemd から `node src/main.ts` で直接起動できる（`03` 5章）。`erasableSyntaxOnly` で、型除去で動かないコードを型チェックの時点で弾く。

**Alternatives considered**: tsx・esbuild によるビルド → 不採用。依存と手順が増える。

## R3. 品質チェックコマンド

**Decision**: `pnpm run check` = `biome ci . && tsc --noEmit && vitest run`。順番は速い順（lint・フォーマット → 型 → テスト）で、最初の失敗で止める。CI（`.github/workflows/ci.yml`）も同じ `pnpm run check` を、`canonical/launch-workshop`（v1.0.1 の SHA で固定）で起動したローカルと同じ Workshop の `dev` の中で呼ぶ。`setup-base` に足したツール（008 の前に入れる gitleaks など）が CI にもそのまま入る。代わりに起動に約2分かかる（setup-node 方式は約9秒）。

**Rationale**: `biome ci` は書き込みをせずに lint とフォーマットの両方を検査するので、CI でもローカルでも同じ結果になる（FR-001・FR-002）。constitution の「CI とファクトリー内テストのコマンドをそろえる」にも合う。

**Alternatives considered**: `biome check --write` を check に含める → 不採用。検査コマンドがファイルを書き換えると CI と結果がずれる。修正用には別に `pnpm run fix` を用意する。

## R4. 設定（`factory.toml`）の読み込みと検証

**Decision**:
- smol-toml で読み、TypeBox 1.x のスキーマで検証する。手順は「既定値を入れる → 検証する → エラーをすべて集めて投げる → `Object.freeze` を深くかけて返す」
- すべての object に `additionalProperties: false` を付け、未知の項目をエラーにする
- 項目名は TOML のまま snake_case で扱う（TS 側で名前を変換しない）
- スキーマで表せない検証（1ジョブの上限 ≤ 月の上限、タイムゾーンが IANA 名として有効か）は、スキーマ検証のあとに自前で行い、同じ形式（パスと理由）のエラーにする
- 秘密情報らしい名前（`key` `token` `secret` `password` を含む）の未知の項目は、未知の項目エラーに「環境変数で渡すこと」という案内を足す
- 設定ファイルの場所は環境変数 `FACTORY_CONFIG`、なければ `./factory.toml`
- 秘密情報は環境変数から読む。001 では「名前を渡すと値を返し、なければ名前付きのエラーを投げる」読み込み口（`requireEnv`）だけを作る

**Rationale**: FR-006〜012 と clarify の決定をそのまま満たす。snake_case のままにすると、TOML とコードの対応を考えなくて済み、エラーのパスも TOML の項目名と一致する。

**Alternatives considered**: 環境変数で設定を上書きできるようにする → 不採用（YAGNI）。設定の出どころが2つになり、検証とレポートが複雑になる。

## R5. 月の区切り（タイムゾーン）

**Decision**: 時刻はすべて UTC のミリ秒（整数）で保存する。「月初」は、設定のタイムゾーン（既定 `Asia/Tokyo`）で現在時刻が属する月の1日 0:00 を UTC のミリ秒に直して求める。計算には `Intl.DateTimeFormat`（`timeZone` 指定）を使い、外部ライブラリは使わない。`budget.month` の値（`YYYY-MM`）も同じタイムゾーンで決める。

**Rationale**: clarify Q1 の決定。保存を UTC に統一すると、タイムゾーンを後から変えても記録を書き換えずに済む。Node 24 では Temporal が使えないので `Intl` で計算する。

**Alternatives considered**: date-fns-tz・Luxon → 不採用。月初の計算1つのために依存を増やさない。

## R6. データベースの開き方とマイグレーション

**Decision**:
- better-sqlite3 で開き、`journal_mode = WAL`・`foreign_keys = ON`・`busy_timeout = 5000`・`synchronous = NORMAL` を設定する
- スキーマは Drizzle で `src/queue/schema.ts` に書き、`drizzle-kit generate` で `drizzle/` に SQL のマイグレーションを作ってコミットする
- 適用は `drizzle-orm/better-sqlite3/migrator` の `migrate()`。起動時（`src/main.ts`）と専用コマンド（`pnpm run db:migrate` → `node src/migrate.ts`）の両方から同じ関数を呼ぶ
- drizzle 0.45 の同期版 migrator は、未適用のマイグレーション全体を `BEGIN`〜`COMMIT` で包み、失敗時は `ROLLBACK` して例外を投げる（ソースで確認）。自前で包む必要はない。変更を残さないことは、壊れたマイグレーションを使うテストで確かめる（管理テーブル `__drizzle_migrations` だけはトランザクションの外で作られる）
- データベースファイルの親ディレクトリがなければ作る
- テストでは `:memory:` か一時ディレクトリのファイルを使う

**Rationale**: clarify Q3 の決定と FR-013〜020。WAL で、後続の HTTP と Worker が同じファイルを読み書きしても読み取りが止まらない。

**Alternatives considered**: `drizzle-kit push` → 不採用。履歴が残らず、FR-014 を満たさない。Node 組み込みの `node:sqlite` → 不採用。constitution で better-sqlite3 と決まっていて、drizzle 0.45 も対応していない。

## R7. better-sqlite3 のネイティブビルド

**Decision**: pnpm 12 はインストール時のビルドスクリプトを既定で止め、止めたときはインストールをエラーにする（`ERR_PNPM_IGNORED_BUILDS`）。許可は `pnpm-workspace.yaml` の `allowBuilds` に書き、esbuild（drizzle-kit の依存）だけを許可する。better-sqlite3 13 は主要な OS・CPU のビルド済みバイナリ（`prebuilds/`）を同梱していて、インストールスクリプトがないため許可は要らない。`saveExact: true` も同じファイルに書く。

pnpm 12 は既定で公開直後のパッケージを入れない（`minimumReleaseAge`）。待ち期間を満たさない版を指定すると、pnpm が `minimumReleaseAgeExclude` に自動で足す。除外は使わず、待ち期間を満たす版を選ぶ（typebox は 1.4.6 ではなく 1.4.5）。

**Rationale**: 許可しないと better-sqlite3 のバイナリが入らず、実行時に初めて失敗する。許可を一覧で絞ると、知らない依存がスクリプトを実行しない。

## R8. ログ

**Decision**:
- pino を標準出力に JSON で出す（journald が受ける）。ログレベルは設定の `log.level`
- `logger.child({ job_id })` で文脈を付ける
- 秘密情報は2段で伏せる
  1. pino の `redact` で項目名を伏せる: `authorization`、`*.authorization`、`headers.authorization`、`*.api_key`、`*.apiKey`、`*.token`、`*.secret`、`*.password`
  2. 値で伏せる: 既知の形（`Bearer …`、`ghp_` `ghs_` `github_pat_` で始まるもの、PEM の秘密鍵のブロック）に合う文字列を `[REDACTED]` に置き換える。対象はメッセージ（`hooks.logMethod`）と、ログに付けたオブジェクト全体（`formatters.log`）。オブジェクトは入れ子のオブジェクトと配列を再帰的にたどる（循環参照は一度見たものを飛ばす）。pino の `formatters.log` はシリアライザーより**前**に呼ばれるので、`Error` はこの中で自前で `{ type, message, stack, cause }` のふつうのオブジェクトにしてから伏せる。`pino.stdSerializers.err` の戻り値は独自のプロトタイプを持つため使わない。標準の `err` シリアライザーは素通しにする（通すと `type` が `Object` に上書きされる）。置き換え関数（`maskSecrets`）は 004 の軌跡のマスクでも使い回すので、`src/trace/mask.ts` に置く
- ローカルでは `pnpm start | pnpm exec pino-pretty` で読みやすくする（本番は JSON のまま）
- `createLogger` は設定全体ではなく `{ level }` だけを受け取る。ロガーを設定の型（`config.ts`）から切り離し、設定の読み込みに失敗したときのエラーも同じロガーで出せるようにする

**Rationale**: FR-021〜024・SC-006。項目名だけで伏せると、メッセージ本文やエラー文に混ざったトークンが漏れるため、値でも伏せる。

**Alternatives considered**: pino の transport で整形する → 不採用。本番は journald に JSON をそのまま渡したい。

## R9. ジョブの二重取り出しの防止

**Decision**: `UPDATE jobs SET status = 'planning', started_at = ?, updated_at = ? WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1) RETURNING *` を、better-sqlite3 の即時トランザクション（`.immediate()`）で実行する。

**Rationale**: FR-018。SQLite は書き込みが1本なので、即時トランザクションの中で「選ぶ」と「書き換える」を1文にすれば二重には取れない（`03` 5章「`UPDATE ... RETURNING` で十分」）。

## R10. ディレクトリ構成とテストの置き場所

**Decision**: リポジトリのルートを `03` 8章の `factory/` に当てる（このリポジトリ自体がファクトリー本体）。テストは対象ファイルの隣に `*.test.ts` で置く。

**Rationale**: 機能ごとにディレクトリが閉じ、後続の機能が `src/<層>/` を足すだけで済む。

**Alternatives considered**: `tests/unit` などに分ける → 不採用。この規模では、ソースとテストを行き来するコストの方が大きい。

## R11. さくらのAI Engine のエンドポイントとモデル名

**Decision**: 001 では設定の項目と型だけを決める。`factory.toml` の値（エンドポイント URL・モデル名）は設計に書かれている名前で仮に置き、002 のスモークテストで実機の正しい値に直す。

**Rationale**: 001 は LLM を呼ばない。正しい値は 002 で実機確認するのが実装計画の順序。
