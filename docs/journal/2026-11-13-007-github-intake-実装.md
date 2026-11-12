# 007 github-intake の実装

`/speckit-implement` で T001〜T032・T034 を実装した。T033（本物の GitHub App で確かめる）は App の作成が要るので残した。`pnpm run check` は 49 ファイル・810 件が通った（Docker を使う 4 件は飛ばした）。

## 調べて分かった事実

### `@octokit/webhooks` の `verify` は文字列しか受け取らない

`@octokit/webhooks-methods` 6.0.0 の `verify(secret, eventPayload, signature)` は、`eventPayload` が文字列でなければ `TypeError`、空なら `secret, eventPayload & signature required` の `TypeError` を投げる。比較そのものは `node:crypto` の `timingSafeEqual`（長さが違えば先に false）。

- 生の本文（バイト列）は `TextDecoder("utf-8", { fatal: true })` で文字列に戻してから渡す。UTF-8 として壊れていれば `false`（GitHub は UTF-8 の JSON しか送らないので、壊れた本文は偽物とみなしてよい）
- 署名のヘッダーは先に `^sha256=[0-9a-f]{64}$` で絞り、空の値で例外にならないようにした

### `octokit` の `App` は秘密鍵を起動時に解析しない

偽の PEM（`-----BEGIN RSA PRIVATE KEY-----` / `rehearsal-dummy` / `-----END ...`）で `new App({ appId: "1", privateKey })` は成功する。鍵を解析するのは JWT を作るとき（最初の API 呼び出し）で、そこで `error:1E08010C:DECODER routines::unsupported` になる。

- 予行演習（`deploy/rehearsal/run.sh`）は偽の鍵のファイルで起動まで通せる。起動時に GitHub を呼ぶのは、中断されたジョブの報告があるときだけ
- quickstart 2章では、署名付きの要求が 31ms で `500`（権限の確認で JWT を作れない）になった。GitHub には届いていない

### `TimeoutStopSec` は 20 ではなく 70 だった

007 の research R11 は「systemd の `TimeoutStopSec=20` に収める」と書いていたが、006 のレビュー（`2026-11-12-006-vps-ops-レビュー.md` 2章）で 70 に変わっていた。Worker の待ちの上限 5 秒は、006 の SC-004（既定の設定で 10 秒以内に止まる）に収める理由で残し、R11 の根拠の文を直した。

### 依頼者が許可ユーザーにいないと、権限の確認まで進まない

quickstart 2章の最初の版は、記録したペイロード（依頼者 `octo-requester`）をそのまま送れば `500` になると書いていた。実際は、許可ユーザー（`factory.toml` の `["Coxless"]`）の確認が先なので `202 ignored`（`reason: not_allowed`）になる。権限の API を呼ぶ前に許可ユーザーで絞るのは意図どおり（API を呼ぶ回数を減らす）なので、quickstart のほうを「依頼者を `Coxless` に書き換えて送る」に直した。

## 想定と違った挙動

### 期限のタイマーが `Date.now()` より先に発火した

インストール中に期限が来たら作業場を消す処理を、最初は `setTimeout(..., deadline - now())` と、戻ったあとの `now() >= deadline` で書いた。テストで、タイマーが発火して `install` が戻った時点でも `now() < deadline` で、`timeout` ではなく `install_failed: 終了コード 137` になった（Node のタイマーはミリ秒の丸めで `Date.now()` より少し早く発火することがある）。

- 期限を `AbortSignal.timeout(deadline - now())` の1つにまとめ、判定もその `aborted` で行うようにした。取得の打ち切り、インストールのコンテナの削除、終わり方の判定がすべて同じ合図を見る

### `stop()` の2回目の呼び出しで止まった

待ちの上限を過ぎた `stop()` のあと、テストの `afterEach` でもう一度 `stop()` を呼ぶと、10 秒の上限まで止まった。2回目は取り出しのループ（終わらない入口を待っている）を待っていた。`stop()` は1回目の Promise を返すようにした。

### `enqueueJob` を受付のトランザクションから呼べなかった

受付で「積む」と「`job_events` に受付の記録（`note`）を書く」を1つのトランザクションにしようとしたが、`enqueueJob` の中にもトランザクションがあり、Drizzle のトランザクションの型（`tx`）は `Db` と合わない。`enqueueJob` に任意の `note` を足し、新しく積んだときだけ同じトランザクションで書くようにした（contracts/module-api.md を直した）。

### 005 の入口に渡す DB を外から用意できなかった

`startFactory` が DB を開くので、`main.ts` で 005 の入口（`GateDeps` に DB が要る）を先に作れない。`startFactory` の3つ目の引数を「DB を受け取って依存を返す関数」（`makeServices`）にした。省けば今までどおり HTTP だけで動くので、006 のテストは変えずに通った。

### 予行演習はコミット済みの HEAD しか確かめない

`setup.sh` を変えたあと、コミットする前に `pnpm run deploy:rehearsal` を流すと、9c（`work_dir` が `/var/lib/sakura-factory/work`）だけが NG になった。予行演習は HEAD を `git bundle` にしてコンテナに clone するので、作業ツリーの `setup.sh`・`factory.toml` ではなく HEAD の古い版が流れていた（`deploy/rehearsal/run.sh` 自体は作業ツリーのもの）。コミット（f253bdf）してから流し直すと、1〜16（2b・9b・9c を含む）がすべて ok になった。

- 配備物を変えたときは、コミットしてから予行演習を流す

## まだ分かっていないこと

- 本物の GitHub App での受付・取得・報告（T033）。`getPermission` が `role_name` に `maintain`・`triage` を返すか、`octokit.auth({ type: "installation" })` のトークンで `http.extraHeader` の clone が通るかは、本物で確かめる
- `octokit` の throttling・retry のプラグインが、権限の確認の 5 秒の打ち切りとどう重なるか
