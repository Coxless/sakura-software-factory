# 007 github-intake の spec・plan・tasks

005（local-pipeline）をローカルで実装している間に、007 の spec → clarify → plan → tasks → analyze を進めた。人間の確認が要る点は、いったん推奨の内容で決めた（spec の Clarifications に5点）。

## 005 に依存しない形にした

`docs/実装計画.md` では 007 は 005 に依存する。依存するのは「Worker が計画から判定までの工程を呼ぶ」ところだけなので、工程を `PipelinePort` という入口の型で受け取ることにした。テストでは偽物を渡し、005 がマージされるまでの本番では「工程がまだ組み込まれていない」と返す仮の入口にする。005 の本物につなぐのは T034 だけ。

- 受付（`/webhook`、署名、`@agent` の判定、権限、予算、積む）は 005 なしで本物の GitHub まで確かめられる
- 005 の入口の形が決まったら、直すのは型とつなぎの関数だけ

## 調べて分かった事実

### ライブラリの版（2026-11-12、registry.npmjs.org）

| パッケージ | 版 | 公開日 |
|---|---|---|
| octokit | 5.0.5 | 2025-10-31 |
| @octokit/webhooks | 14.2.0 | 2025-12-03 |
| @octokit/app | 16.1.4 | 2026-08-02 |
| @octokit/auth-app | 8.3.1 | 2026-09-01 |
| @octokit/webhooks-methods | 6.0.0 | 2025-05-20 |

`octokit` 5.0.5 は1年前の版で、中の `@octokit/app` などは新しい版が出ている。`octokit` が依存の範囲で新しいほうを引くかは、入れたときの `pnpm-lock.yaml` で確かめる。

### GitHub は失敗した Webhook を自動では再送しない

最初の spec では「権限の確認や DB の失敗では `503` を返して GitHub に再送させる」と書いていた。GitHub は失敗した配送を自動では再送しない（App の設定画面の「Recent Deliveries」から手で再送するだけ）ので、これは成り立たない。clarify で直した。

- 失敗は `500` を返し、配送の ID をログに残す。運用者が手で再送する
- 受信箱のテーブルに生の本文を保存して非同期に処理すれば取りこぼしを減らせるが、1台・同時実行1件の構成には過剰なので採らなかった

### トークンを git にどう渡すか

| 方法 | 問題 |
|---|---|
| URL にトークンを埋めて clone | `.git/config` の `remote.origin.url` に残る。作業場は `.git` を読み取り専用で見られるので、実装役から読める |
| `git -c http.extraHeader=...` | `/proc/<pid>/cmdline` に出る（プロセスの一覧から見える） |
| 環境変数 `GIT_CONFIG_COUNT`・`GIT_CONFIG_KEY_0`・`GIT_CONFIG_VALUE_0` | 同じユーザーにしか見えず、どこにも書き残さない → **採用** |

## analyze で直したこと

- テストで作業場の片付けを偽物にする前提なのに、Worker の依存（`WorkerDeps`）にその関数がなかった → `removeSandboxes` を足した
- 「作業ブランチの名前がリモートと重なったら `failed`」と書いていたが、007 は push しないので判定できない → 008 で扱うと書き直した
- 取得に失敗して作業ブランチがないときの、報告の「作業ブランチ」の欄を決めた（「なし」）
- SC-005（報告はちょうど1回）と SC-006（トークンがどこにも出ない）を確かめるタスクに、SC の番号と、ログにトークンが出ないことの確認を足した

## まだ分かっていないこと

- 005 の入口の形（`onPhase` を 005 が呼ぶか、007 が工程を分けて呼ぶか） → 005 のマージで決まった（下の「005 のマージ後に plan を見直した」）
- `octokit` 5.0.5 と Node 24 の型除去の組み合わせで問題が出ないか
- `gh webhook forward` で、ローカルの `/webhook` に本物の配送を転送できるか（quickstart の3章）

## 005 のマージ後に plan を見直した

005（PR #10）が main に入ったので、`007-github-intake` を `origin/main`（31e23f7）にリベースした（衝突なし）。007 の plan は「005 の入口が未定」という前提で `PipelinePort` を自前で定義していたので、005 の実物（`src/pipeline/run.ts`）と突き合わせた。

### 食い違っていたこと

| # | 007 の plan の想定 | 005 の実物 | 直したこと |
|---|---|---|---|
| 1 | 入口は 007 の型 `{ verdict, summary, failureKind }` を返す | `runPipelineInSandbox(deps, input) → PipelineResult`（`outcome` が6種、`diff`・`plan`・`verdict` 付き） | 007 で型を詰め直さず、`PipelineResult` をそのまま受け取る。分類は Worker の `classifyOutcome` だけで行う。詰め直すと 008 が使う `diff`・`plan.work_type` を捨てることになる |
| 2 | 判定の不合格は `pipeline_failed` に含める（data-model）／`judge_rejected` がある（research R10） | `rejected` を `failed` と分けて返す | 007 の文書どうしでも食い違っていた。`judge_rejected` を分類に足した |
| 3 | `onPhase` で `planning` → `implementing` → `testing` → `judging` と1回ずつ進む | 最初に `planning`(0) を呼ぶ（ジョブは取り出した時点で `planning`）。実装工程がターン数の上限で終わると `testing` を通らず、次の回で `implementing` → `implementing` | 同じ状態なら何もしない。いまの `transition` は同じ状態を「表にない遷移」として拒否するので、そのままだと毎ジョブ例外のログが出ていた（005 は `onPhase` の例外を握りつぶすので工程は止まらない） |
| 4 | 時間の上限は 007 の `AbortController` で 005 を止める | 005 は `deadline`（Unix ミリ秒）を必須で受け取り、自分で `timeout` を返す | 期限を `started_at + job_timeout_minutes` で決めて渡す。`signal` は停止の合図だけにする |
| 5 | `install(workdir, signal)` で中断できる | 003 の `installDependencies` は `AbortSignal` を受け取らない（`install_timeout_seconds` でだけ止まる） | 停止・期限のときは `removeStaleSandboxes({ jobId })` でインストール用のコンテナを消して戻らせる（ラベルで `factory-install-<jobId>` も選べる）。003 は変えない |
| 6 | Worker が作業場を片付ける | `runPipelineInSandbox` が作業場を作って `finally` で壊す | Worker の片付けは保険として残す |

見直しの途中で、もう1つ見つかった。

- `jobs` に Issue の題と本文の列がない（001 のスキーマ）。plan の `AgentRequest` には `issueTitle`・`issueBody` があったが、積むときに捨てていた。005 は Issue と依頼の両方が空だと `failed` にする。スキーマを変えずに、Worker が準備のときに `GitHubPort.getIssue` で取ることにした（取り出した時点の最新の題と本文になる）

### `install_command` を設定に出した

最初の spec は依存のインストールを `pnpm install --frozen-lockfile` の決め打ちにしていた。005 で工程内テストのコマンドを `[pipeline] check_commands` として設定に出したので、インストールだけ決め打ちだと対象リポジトリに合わせる場所が2つに割れる。`[pipeline] install_command`（既定は同じ、空なら飛ばす）を足した。

### AI解禁の前に本物の GitHub で Worker まで通す方法

005 の本物の入口をつなぐと、quickstart 3章の「Worker を動かす」はさくらを呼ぶことになる（以前は仮の入口だったので呼ばなかった）。005 の `runPipeline` は、計画役を呼ぶ前に `[models].verifier === [models].implementer` を確かめて `failed` を返す（`src/pipeline/run.ts:206`）。確認用の設定でこの2つを同じにすれば、取得・インストール・作業場・報告までを LLM なしで通せる。

### まだ分かっていないこと

- `getIssue` で取った Issue の本文が、依頼のあとに編集されていた場合の扱い（今は最新を使う。依頼の時点の本文を使うべきかは、運用で困ったら決める）

### 見直しのあとの analyze で直したこと

- `.specify/feature.json`（gitignore 済み）が、リベースのあとも 005 を指したままだった。`check-prerequisites.sh` が 005 を返すので、`/speckit-implement` が 005 の tasks を対象にするところだった。007 に書き換えた
- `stop()` に待ちの上限がなかった。005 の工程内テストのコマンドは最大 600 秒なので、中断にすぐ応じないと systemd の `TimeoutStopSec=20` を超える。上限を 5 秒（`stopTimeoutMs`）にした。過ぎたら状態を変えずに抜け、次の起動で `restarted` として報告する。待ちの途中で `failed` にすると、報告の投稿が間に合わなかったときに起動時の掃除の対象から外れて、報告が失われるため
- Worker の中断の合図を停止専用にしたので、取得の期限切れの合図がなくなっていた。取得には停止と期限を合わせた合図（`AbortSignal.any`）を渡すことにした
- 準備で止まったジョブの状態は `planning` のままなので、報告の「止まった工程」が `planning` と出て、計画役の失敗と取り違えやすい。準備で止まったときは「準備」と表示する

