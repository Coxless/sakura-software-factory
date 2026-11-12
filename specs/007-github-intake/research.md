# Research: 受付とジョブキュー（007）

各項目は「決定・理由・検討した代替」の順に書く。版は 2026-11-12 に `registry.npmjs.org` で確かめた。

## R1. GitHub のライブラリ

- **決定**: `octokit` 5.0.5（`App` クラスで App の認証・インストールトークン・REST を扱う）と `@octokit/webhooks` 14.2.0（署名の検証とペイロードの型）。完全固定する。使うのは `src/github/` の中だけ
- **理由**: constitution の主要ライブラリ。`@octokit/webhooks` の `verify` は HMAC-SHA256 を定数時間で比べる（FR-002）。インストールトークンの発行と期限切れ前の更新を `App` に任せられる
- **代替**: `node:crypto` の `timingSafeEqual` で自分で比べる → 同じことができるが、constitution の指定と型付きのペイロードを捨てることになる。`@octokit/rest` と `@octokit/auth-app` を個別に入れる → `octokit` がまとめて持つ

## R2. 005 の工程の呼び方

- **決定**: 005 の `runPipelineInSandbox(deps, input)`（作業場を作り、`runPipeline` を回して片付ける）を入口にする。Worker は `PipelinePort = (input: Omit<PipelineInput, "workspace">) => Promise<PipelineResult>` を引数で受け取り、本物は `main.ts` で `runPipelineInSandbox` に `PipelineDeps` を束ねて作る。テストでは `PipelineResult` を返す偽物を渡す
- **渡すもの**: `jobId`、`workdir`、`issue`（題と本文。`jobs` には列がないので、準備のときに `GitHubPort.getIssue` で取る。スキーマは変えない）、`instruction`、`deadline`（R7）、`signal`（停止の合図だけ）、`onPhase`（R7）。`plan` は渡さない（計画役を回す）
- **理由**: 005 は 007 の Worker から呼ばれる形でこの関数を用意した（005 の contracts/module-api.md）。007 で `{ verdict, summary, failureKind }` に詰め直すと、008 が使う `diff`・`plan.work_type`・`verdict` を Worker が捨てることになる。結果の分類は Worker の中の1つの関数（`classifyOutcome`）で行う
- **代替**: 007 独自の入出力の型とつなぎの関数 → 005 が未定だったときの案。005 の型が決まった今は、同じ情報を2つの型で持つだけになる

### 結果の分類（`classifyOutcome`）

| 005 の `outcome` | 007 の扱い | 報告の詳細 |
|---|---|---|
| `passed` | `shipping_not_available`（008 までは出荷しない） | `verdict.reasons` |
| `rejected` | `judge_rejected` | `reason`（最後の不合格の理由） |
| `failed` | `pipeline_failed` | `error` か `reason` |
| `budget_exceeded` | `budget_exceeded` | `error` |
| `timeout` | `timeout` | なし |
| `aborted` | `stopped`（007 が `signal` を中断するのは停止の合図のときだけ） | なし |

- 入口が例外を投げたら `internal_error`（005 は例外で reject しない約束だが、念のため）
- 報告の詳細には、やり直しの回数（`retries`）と最後の diff の数（`diffStat`）も入れる。diff そのものは入れない

## R3. Webhook の受け取り

- **決定**: `POST /webhook` は Hono の `bodyLimit`（`[github] webhook_max_body_kb`、既定 1024）で本文の大きさを先に絞り、生の本文（バイト列）で `X-Hub-Signature-256` を検証してから JSON として解釈する。イベントは `X-GitHub-Event`、配送の ID は `X-GitHub-Delivery` から取る
- **理由**: 署名は生の本文に対して計算されるので、解釈し直した JSON では検証できない。大きさを先に絞らないと、検証の前に大きな本文を読み込んでしまう（FR-003）
- **応答**: 受け付けた `202`、対象でない `202`、`ping` は `200`、署名の誤り `401`、大きすぎ `413`、JSON の誤り `400`、権限の確認や DB の失敗 `500`。本文は短い JSON（`{"result":"queued"}` など）で、内部の情報を含めない
- **代替**: 受信箱のテーブルに生の本文を保存してから非同期に処理する → GitHub が自動で再送しない失敗を減らせるが、1台・同時実行1件の構成には過剰（spec の Clarifications）

## R4. 依頼の判定

- **決定**: 純粋関数 `parseAgentRequest(body)` で、改行で分けて最初の空でない行が `/^@agent(\s|$)/` に合うかを見る。合えば、その行の `@agent` のあとと、続く行をすべて本文にする。本文は `[github] max_instruction_chars`（既定 20000）で切り詰める
- **対象の絞り込み**: `issue_comment` で `action == "created"`、`issue.pull_request` がない、`issue.state == "open"`、`comment.user.type != "Bot"`、`comment.performed_via_github_app` がない
- **理由**: FR-005・FR-007・FR-008。最初の行に限れば、引用（`>`）やコードの中は自然に外れる
- **代替**: 本文のどこかに `@agent` があれば依頼にする → 説明の中で触れただけで動き、予算を消費する

## R5. 権限の確認

- **決定**: `GET /repos/{owner}/{repo}/collaborators/{username}/permission` の `permission` が `admin`・`maintain`・`write` のどれか、かつ `[github] allowed_users` に含まれる（大文字と小文字を区別しない）ときだけ積む。API は受付の応答の中で1回呼び、5 秒で打ち切る
- **理由**: FR-009・FR-011。毎回確かめるので、権限を外された人はすぐに動かせなくなる
- **代替**: 許可ユーザーだけで決める → リポジトリの権限を外しても動かせてしまう

## R6. 受付の流れと予算

- **決定**: 署名 → 解釈 → 対象の絞り込み → 依頼の判定 → 権限の確認 → 予算の確認（002 の `canAcceptNewJob`）→ 積む（`INSERT ... ON CONFLICT (repo, trigger_comment_id) DO NOTHING`）→ `202` を返す → リアクション（`eyes`）を付ける（応答のあと、失敗してもログだけ）
- **予算切れ**: その月の `budget.intake_stopped_at` が NULL なら時刻を書く。Issue に「今月の予算が残っていない」旨のコメントを書く（応答のあと）
- **本文が空**: Issue に使い方のコメントを書く（応答のあと）
- **理由**: FR-004・FR-006・FR-012〜FR-015。コメントとリアクションは応答の速さに関係しないよう、応答のあとに回す（SC-004）

## R7. Worker と状態機械

- **決定**:
  - `src/pipeline/state.ts`: 遷移の表（`03` 3章の全状態）と `transition(db, jobId, from, to, detail)`。`UPDATE jobs SET status = to WHERE id = ? AND status = from` と `job_events` の追加を1つのトランザクションで行い、表にない遷移と、現在の状態が `from` でない場合は例外にする
  - `src/pipeline/worker.ts`: `claimNextQueuedJob`（001）で1件取り出す（`queued` → `planning`）。取り出せなければ `[worker] poll_interval_seconds`（既定 5）待つ。受付がジョブを積んだら、待ちを打ち切ってすぐ取り出す
  - 1件の処理: 準備（取得・ブランチ・インストール）→ 005 の入口 → 結果を分類して報告し `failed`（008 までは合格も `failed`）→ 片付け
  - 期限: 取り出した時刻 + `[limits] job_timeout_minutes` を `deadline` として決める。005 には `deadline` を渡し、005 が期限を過ぎたら自分で `timeout` を返す。準備（取得・インストール）は期限までの残りで打ち切る（取得は `AbortSignal`、インストールは R11）
  - 期限は FR-022 の「ジョブ全体の時間の上限」のこと
  - 中断: Worker の `AbortController` は停止の合図のときだけ中断し、005 の `signal` に渡す（005 は期限を自分で見る）。取得（`cloneForJob`）には、停止の合図と期限を合わせた合図（`AbortSignal.any([停止, AbortSignal.timeout(期限までの残り)])`）を渡す。どちらで止まったかは、停止の合図が中断されているかで見分ける
- **状態を進めるのはだれか**: 005 は工程の境目で `onPhase(phase, round)` を呼ぶ（状態は書かない）。007 は受け取った `phase` へ `transition` する。005 の呼び方には次の2つがあるので、**現在の状態と同じ `phase` は何もしない**（記録も残さない）
  - 最初に `planning`（round 0）を呼ぶ。ジョブは取り出した時点で既に `planning`
  - 実装工程がターン数の上限などで終わると `testing` を通らず、次の回の `implementing` が `implementing` → `implementing` になる
- 上の2つ以外の 005 の呼び方（`implementing` → `testing` → `implementing`〔テストの失敗の差し込み〕→ `testing` → `judging` → `implementing`〔やり直し〕）は遷移の表に収まる。表にない遷移が来たら `transition` の例外をログ（`warn`）に残して状態を変えない（005 は `onPhase` の例外を握りつぶすので、工程は止まらない）
- **理由**: FR-016〜FR-024。工程の遷移はコードで決め打ちにする（原則 II）
- **代替**: 状態機械のライブラリ → 原則 II（自前の決め打ち）に反する

## R8. 取得とトークン

- **決定**: インストールトークンを `GIT_CONFIG_COUNT=1`・`GIT_CONFIG_KEY_0=http.extraHeader`・`GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64(x-access-token:トークン)>` の環境変数で git に渡す。リモートの URL は `https://github.com/<owner>/<repo>.git`（トークンなし）。`git clone --depth 1 --single-branch` で既定のブランチだけを取り、`git switch -c agent/issue-<番号>-job-<ジョブ番号>` で作業ブランチを作る
- **理由**: FR-019。`-c` の引数で渡すとプロセスの一覧（`/proc/<pid>/cmdline`）に出る。環境変数は同じユーザーにしか見えない。`.git/config` に書かないので、作業場から読み取り専用で見える `.git` にもトークンは入らない
- **エラー**: git の出力に含まれうるトークンは、ログと報告の前にマスクする（トークンの値そのものを伏せ字の対象に足す）
- **代替**: URL にトークンを埋めて clone する → `.git/config` の `remote.origin.url` に残り、作業場（`.git` は読める）から見える

## R9. 作業ディレクトリ

- **決定**: `[storage] work_dir`（既定 `data/work`、設定ファイルの場所が基準）の下に `job-<ジョブ番号>/repo` を作る。VPS では `/var/lib/sakura-factory/work`。006 の `setup.sh` の `factory.toml` の書き換えに `work_dir` を足す
- **理由**: FR-020。006 の systemd の `PrivateTmp` の `/tmp` は Docker デーモンから見えない
- **片付け**: ジョブの終わりに `job-<番号>` を消す。起動時に `work_dir` の下の `job-*` をすべて消す（FR-024・FR-028）

## R10. 失敗の報告

- **決定**: `src/pipeline/report.ts` で本文を組み立て、`github/` 層でコメントする。項目は、ジョブの番号、止まった工程（失敗したときの状態）、理由（分類と短い説明）、消費したリクエスト数（`countLlmCallsForJob`。準備の失敗など 005 の結果がないときも数えられる）、005 の結果があればやり直しの回数と diff の数。本文は `maskSecrets` を通す。二重の投稿を防ぐため、投稿の前に `job_events` に `report_posted` のメモ（`type = "note"`、`detail` に種類）があるかを見る
- **理由**: FR-025〜FR-027。`job_events` の種類は増やさず、`note` の `detail` で区別する（001 のスキーマを変えない）
- **失敗の理由の分類**: `clone_failed`・`install_failed`・`pipeline_failed`・`judge_rejected`・`timeout`・`budget_exceeded`・`shipping_not_available`・`restarted`・`stopped`・`internal_error`（data-model.md と同じ。005 の結果との対応は R2）

## R11. 起動と停止

- **決定**: 起動時に、`planning`〜`judging` のジョブを `failed`（`restarted`）にして報告し、003 の `removeStaleSandboxes()` と `work_dir` の掃除をしてから Worker を始める。停止の合図では、Worker の取り出しを止め、処理中のジョブの `AbortController` を中断し、`failed`（`stopped`）にしてから 006 の HTTP の停止に進む
- **インストールの打ち切り**: 003 の `installDependencies` は `AbortSignal` を受け取らず、`[sandbox] install_timeout_seconds` でだけ止まる。停止の合図・期限が来たら、Worker は `removeSandboxes(jobId)`（003 の `removeStaleSandboxes({ jobId })`。ラベルで `factory-install-<jobId>` も選ぶ）でコンテナを消し、`installDependencies` を戻らせる。そのあとの分類は、中断の理由（停止なら `stopped`、期限なら `timeout`）を終了コードより優先する。003 は変えない
- **作業場の片付け**: 実装工程の作業場は 005 の `runPipelineInSandbox` が `finally` で壊す。Worker の `finally` の `removeSandboxes(jobId)` は、005 の片付けの失敗とインストール用のコンテナの残りに備えた保険として残す
- **停止の待ちの上限**: `stop()` は処理中のジョブが終わるのを最大 5 秒（`WorkerDeps.stopTimeoutMs`、既定 5000）待つ。5 秒以内に終われば、`failed`（`stopped`）にして報告してから resolve する。過ぎたら、ジョブの状態を変えずに resolve する。状態が `planning`〜`judging` のまま残るので、次の起動で `restarted` として報告される。待ちの途中で `failed` にしないのは、報告の投稿が間に合わないと、起動時の掃除の対象（`planning`〜`judging`）から外れて報告が失われるため
- **理由**: FR-028・FR-029。停止は 006 の SC-004（既定の設定で 10 秒以内に終わる）と systemd の `TimeoutStopSec=70` に収める。内訳は、Worker の 5 秒と、006 の HTTP の停止（`shutdown_timeout_seconds`、既定 10。待ち受けの接続がなければすぐ終わる）。005 の工程内テストのコマンド（最大 600 秒）や LLM の呼び出しが中断にすぐ応じなくても、上限で抜ける
- **`pr_opened` 以降の状態**: 008・009 で扱う。起動時の掃除では触らない

## R12. 設定と環境変数

- **決定**: `factory.toml` に `[github]` の項目（`webhook_max_body_kb`・`max_instruction_chars`）、`[worker]`（`poll_interval_seconds`）、`[storage] work_dir`、`[pipeline] install_command`（R13）を足す。環境変数は `GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY_PATH`（`root:factory`、`0640` のファイル）・`GITHUB_WEBHOOK_SECRET`。006 の `factory.env.example` と `setup.sh` の必須の確認に足す
- **理由**: FR-031・FR-032。秘密鍵は複数行なので、環境変数に直接入れずにファイルの場所を渡す
- **環境変数がないとき**: 起動時に名前を含むエラーで止まる（`requireEnv`）

## R13. 依存のインストールのコマンド

- **決定**: `[pipeline] install_command`（文字列、既定 `"pnpm install --frozen-lockfile"`）を足す。003 の `installDependencies` に `["sh", "-c", install_command]` で渡す（005 の `pipeline:dev --install` と同じ渡し方）。空文字ならインストールを飛ばして 005 の入口に進む（起動時に `warn` のログ）。終了コードが 0 以外なら `install_failed`（報告の詳細に標準エラーの末尾 2000 文字をマスクして入れる）
- **理由**: 対象リポジトリの CI に合わせるコマンドは、005 の `[pipeline] check_commands` で既に設定にしている。インストールだけを決め打ちにすると、npm や別の pnpm の引数のリポジトリで工程内テストが依存を見つけられない。置き場所を `[pipeline]` にして、対象リポジトリに合わせる設定を1か所にまとめる
- **代替**: 決め打ち（`pnpm install --frozen-lockfile`） → 最初の spec の案。対象リポジトリを変えるたびにコードを直すことになる。対象リポジトリの `package.json` から推測する → 推測を誤ったときの挙動が読めない
