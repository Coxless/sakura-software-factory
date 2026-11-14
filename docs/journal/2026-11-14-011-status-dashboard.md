# 2026-11-14 011 計測と状況ページ（/status）

## やろうとしたこと

`03` 7章の5つの数値（今月の消費・成功率・平均処理時間・CI 初回通過率・デプロイ成功率）と、工程の実行の要約（`agent_runs`）を `GET /status` で見られるようにする。データは 002〜010 で記録済みなので、新しい表は足さずに読むだけで作る。

## 公開範囲をどう決めたか

- `/status` は 006 の Caddyfile で最初から「公開するパス」に入っていた（`@factory path /healthz /webhook /status`）。つまり作った瞬間に `https://<FACTORY_DOMAIN>/status` で誰でも見られる
- 最初の案は「認証なしで公開し、集計値と要約だけを出す（リポジトリ名・Issue・エラー文は出さない）」。審査員にそのまま見せられるのが利点
- 運用者の判断は「脆弱性になりそうなものは入れたくない」→ **Caddy の Basic 認証付きで公開**に決めた
- 認証があっても、依頼の本文・エラー文・軌跡の中身と場所は出さない。認証が破られる場合と、画面の写しを記事に載せる場合を考えて、出してよい範囲を「番号・状態・時刻・件数・終わり方・失敗の理由の種類・リポジトリ名」に絞った
- `jobs.failure_reason` は `<種類>: <文>` の形で、後ろの文にはエラー文が入りうる。表示は先頭の種類だけにし、`FAILURE_KINDS` にない語は `other` にした

## 認証をどこに置くか

- 候補: (a) Caddy の `basic_auth`、(b) ファクトリー本体で `hono/basic-auth`、(c) 公開せず SSH のポート転送だけ
- (a) にした。ファクトリーは `127.0.0.1:8787` でだけ待ち受けていて、外からの経路は Caddy だけ。本体でも認証すると秘密の値がファクトリーの環境変数に増え、比較の実装とテストも増えるのに、守る場所が二重になるだけ
- 認証の値がないときの扱い: Caddy の条件分岐で「値が空なら 404」と書く案もあったが、`setup.sh` の `check_secret_file` で必須にして配備を止めるほうが単純で、認証なしで出る経路が残らない

## 調べて分かったこと: Caddy 2.11.9 の basic_auth と空の値

`deploy/Caddyfile` に `basic_auth { {$STATUS_USER} {$STATUS_PASSWORD_HASH} }` を書き、`caddy validate` に環境変数を変えて渡した。

| `STATUS_USER` | `STATUS_PASSWORD_HASH` | 結果 |
|---|---|---|
| `u` | 空 | `parsing caddyfile tokens for 'basic_auth': username and password cannot be empty or missing` で失敗 |
| 空 | 正しいハッシュ | 同じエラーで失敗 |
| `u` | `x`（bcrypt ではない） | `provision http.authentication.providers.http_basic: base64-decoding password: illegal base64 data at input byte 0` で失敗 |
| `u` | `caddy hash-password` の出力 | `Valid configuration` |

- 値が空でも Caddy 側で検証が落ちるので、`setup.sh` の確認をすり抜けても「認証なしで転送する」設定にはならない（二重に fail closed）
- ハッシュでない文字列は「base64 として読めない」と言われる。Caddy は古い形式（base64 で包んだハッシュ）も受け付けるため、`$2a$` で始まらない値は base64 として読もうとする

## ハッシュの `$` の扱い

- `caddy hash-password --plaintext ...` の出力は `$2a$14$TS0D...` の形
- `setup.sh` は `caddy.env` を bash で `source` してから `caddy validate` を流す。引用符なしで書くと `$2a`・`$14` が変数として展開されて値が壊れる
- 単一引用符で囲む（`STATUS_PASSWORD_HASH='$2a$14$...'`）と、bash の `source` でも systemd の `EnvironmentFile=` でも中身がそのまま渡る。手順書（`deploy/README.md`）と `caddy.env.example` に書いた
- `deploy/scripts/lint.sh` に検査用の固定のハッシュ（平文は `lint`、秘密ではない）を単一引用符で置いたら、shellcheck が `SC2016 (info): Expressions don't expand in single quotes` で失敗した。展開させないのが目的なので、その行だけ `# shellcheck disable=SC2016` にした。gitleaks はこのハッシュを検出しなかった

## 作っている途中で当たったこと

- `status:dev` のテストで、`loadConfig()` の結果の `storage.database_path` を書き換えたら `Cannot assign to read only property 'database_path'` で落ちた。設定は凍結されている。テストでは `{ ...config, storage: { ...config.storage, database_path } }` で写しを作った
- 常駐のファクトリー（`pnpm start`）は `assertProductionProvider` で開発用の設定（Google AI Studio）を拒み、GitHub App の秘密鍵も要るので、ローカルでは `/status` を開けない。同じ集計を出す `pnpm run status:dev` を足した（DB は `readonly`・`fileMustExist` で開き、マイグレーションもしない）
- テスト用のデプロイの commit を `n.toString(16).padEnd(40, "0")` で作ったら、`1` と `16`（`"1"` と `"10"`）が同じ文字列になって一意制約に当たりうると気づき、先に4桁にそろえた

## 数値

- 1か月分の記録（LLM 呼び出し 3,000 件・ジョブ 500 件・CI の結論 500 件・工程の実行 500 件）で、記録を入れる時間を含めたテスト全体が 384ms（集計そのものはこれより短い）。SC-003（1 秒以内）を満たす
- 新しい索引・マイグレーションは足していない。`llm_calls` は `created_at` の索引がある。`job_events` は月で絞るだけで数千件の規模

## まだ分かっていないこと

- 本番の VPS（12-03 以降）で、ブラウザの Basic 認証のダイアログと CSP（`style-src` のハッシュ指定）が想定どおりに動くか。予行演習は curl で確かめた

## 開発用の DB で確かめたこと

- `pnpm run status:dev` を開発用の DB（`data/factory.dev.db`）に流したら `no such column: repo` で止まった。開発用の DB は 010 のマイグレーション（`deployments` の作り直し）の前のままだった。`status:dev` は読み取り専用でマイグレーションしないので、このエラーのときは `FACTORY_CONFIG=factory.dev.toml pnpm run db:migrate` を案内するようにした
- マイグレーションのあとは、今月（`2026-11`、`Asia/Tokyo`）の消費が 52 件（実装役 39・検査役 11・計画役 2）と出て、同じ範囲を SQL で数えた `count(*)` の 52 と一致した。Workshop には `sqlite3` コマンドがないので、確かめは `node -e` と better-sqlite3 で行った
