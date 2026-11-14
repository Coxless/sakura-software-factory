# Research: 計測と状況ページ（status-dashboard）

## R1. 認証をどこで行うか

- **Decision**: Caddy の `basic_auth`（bcrypt のハッシュ）で `/status` だけを守る。ファクトリー本体では認証しない
- **Rationale**: ファクトリーは `127.0.0.1` でだけ待ち受けていて、外からは Caddy を通らないと届かない（006）。Caddy の `basic_auth` は実績があり、ハッシュの比較や総当たりの遅延（bcrypt のコスト）を自前で書かずに済む。`/healthz`・`/webhook` には付けない（GitHub と監視が使う）
- **Alternatives considered**:
  - 本体で Basic 認証（`hono/basic-auth`）→ 秘密の値がファクトリーの環境変数に増え、比較の実装とテストも増える。外からの経路は Caddy だけなので、守る場所が二重になるだけ
  - 公開しない（SSH のポート転送だけ）→ ユーザーの判断で、認証付きの公開を選んだ
  - Cookie のログイン画面 → 1人で使うには大きすぎる

## R2. 認証の値がないとき

- **Decision**: `STATUS_USER`・`STATUS_PASSWORD_HASH` を `caddy.env` の必須の値にし、`setup.sh` は空なら止まる（ほかの値と同じ `check_secret_file`）。Caddy でも値が空のままでは `caddy validate` が通らないことを確かめておく
- **Rationale**: 「認証の設定がなければ転送しない」を Caddy の条件分岐で書くより、配備の時点で止めるほうが単純で、認証なしで公開される経路が残らない（fail closed）
- **Alternatives considered**: Caddy の matcher で「値が空なら 404」→ 設定が複雑になり、検査も増える
- **spec への反映**: FR-017 は「認証の設定がない配備は止まり、認証なしで状況ページが外に出ることはない」と読む（404 ではなく配備の停止で満たす）

## R3. パスワードのハッシュの置き方

- **Decision**: `caddy hash-password` の出力（`$2a$14$...`）を、`caddy.env` に **単一引用符で囲んで** 書く（`STATUS_PASSWORD_HASH='$2a$14$...'`）
- **Rationale**: `setup.sh` は `caddy.env` を bash で `source` し、systemd は `EnvironmentFile=` で読む。引用符なしだと bash が `$2a` などを変数として展開して値が壊れる。単一引用符はどちらでも中身をそのまま渡す
- **確かめ方**: 予行演習で、引用符付きで書いたハッシュに対して正しいパスワードで 200 になることを確かめる

## R4. 成功率・処理時間・CI 初回通過率・デプロイ成功率の数え方

- **Decision**:
  - 成功率: `jobs.finished_at` が今月の範囲にあり、`status` が `deployed`・`rolled_back`・`failed` のジョブ。分子は `deployed`
  - 処理時間: 同じジョブのうち `started_at` と `finished_at` があるもの。平均と中央値（中央値は JS で並べて求める。件数は数百）
  - CI 初回通過率: `job_events` の `type = 'note'` で `detail` の `kind = 'ci_result'`・`attempt = 1` のもの（009 が1つのジョブに最初の結論で1回だけ書く）のうち、`created_at` が今月の範囲にあるもの。分子は `conclusion = 'success'`。ジョブごとに1件に絞る（`DISTINCT job_id`）
  - デプロイ成功率: `deployments.finished_at` が今月で `status` が `succeeded`・`failed`。分子は `succeeded`。ロールバックは `rolled_back = 1` の件数
- **Rationale**: 「終わった時刻の月」で数えると、月をまたいだジョブを二重に数えない。CI の最初の結論は 009 の記録をそのまま使え、新しい列が要らない
- **Alternatives considered**: `jobs.created_at` の月で数える → 月末に積んだジョブが翌月に終わると、今月の率がまだ決まらない値になる

## R5. 失敗の理由をどう出すか

- **Decision**: `jobs.failure_reason` は `<種類>: <文>` の形（`pipeline/report.ts` の `failJob`）。表示は先頭の種類だけを取り出し、`FAILURE_KINDS` に含まれるときだけ出す（それ以外は `other`）
- **Rationale**: 後ろの文はエラー文を含みうる（マスク済みでも、パスや内部の情報が入りうる）。種類は決まった語なので出してよい

## R6. HTML の組み立てと XSS 対策

- **Decision**: `hono/html` の `html` タグで組み立てる（埋め込んだ値は自動でエスケープ）。`raw()` は使わない。CSS は1つの `<style>` に置き、その SHA-256 を CSP の `style-src` に入れる。`default-src 'none'; style-src 'sha256-…'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`。ほかに `X-Content-Type-Options: nosniff`・`Referrer-Policy: no-referrer`・`Cache-Control: no-store`
- **Rationale**: 記録の文字列（リポジトリ名・モデル名・工程名）はジョブの入力から来うる。エスケープと CSP の二重で、仮にエスケープ漏れがあってもスクリプトは動かない。ハッシュ指定なので `'unsafe-inline'` が要らない
- **Alternatives considered**: JSX（`hono/jsx`）→ tsconfig の設定が増える。テンプレートエンジン → 依存が増える

## R7. JSON の形式の選び方

- **Decision**: `?format=json` のときだけ JSON。ほかの値・指定なしは HTML。`Accept` は見ない
- **Rationale**: ブラウザでも curl でも URL だけで決まり、テストも単純。知らない値をエラーにしない（spec の US3-2）

## R8. 一覧の件数

- **Decision**: ジョブ 20 件、工程の実行 30 件、デプロイ 10 件（コードの定数）
- **Rationale**: 1ジョブで工程の実行が 3〜6 件できるので、工程はジョブより多めにする。設定にするほどの必要はない（YAGNI）

## R9. 一覧の「使ったリクエスト数」

- **Decision**: ジョブごとに `llm_calls` の件数を数える（`job_id` の索引あり。20 件分だけ）
- **Rationale**: 予算ゲートが数える値と同じ。`agent_runs.requests` の合計だと、記録の途中で落ちた実行の分がずれる
