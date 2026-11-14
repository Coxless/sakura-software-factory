# Research: 出荷とレポート（008）

各項目は「決定・理由・検討した代替」の順に書く。gitleaks の挙動は 2026-11-14 に Workshop（gitleaks 8.30.1）で確かめた。

## R1. 出荷の工程を置く場所

- **決定**: Worker（`src/pipeline/worker.ts`）の 005 の入口のあとに、`outcome == "passed"` のときだけ出荷の工程（`src/pipeline/ship.ts` の `shipJob`）を呼ぶ。作業場（コンテナ）は 005 の入口が片付け済みで、出荷はホストの git と gitleaks だけで行う。`classifyOutcome` の `passed` → `shipping_not_available` は消す（FR-020）
- **理由**: commit・push はホストだけが行う（原則 IV）。作業ディレクトリは Worker が持っていて、出荷が終わるまで消さない（`finally` の片付けは出荷のあと）
- **代替**: 005 の `runPipeline` の中で出荷する → 005 は GitHub を知らない層（012 の回帰評価も判定で止める）なので混ぜない

## R2. commit の作り方

- **決定**: 005 の diff と同じ範囲（工程の開始時の HEAD からの全変更。追跡していない新しいファイルを含み、`.gitignore` に従う）を `git add -A` → `git commit` で1つの commit にする。git はホストで次の設定を付けて呼ぶ
  - `-c core.hooksPath=/dev/null`（フックを実行しない）、`-c core.fsmonitor=false`、`-c commit.gpgSign=false`、`-c core.quotePath=false`
  - 環境変数は `GIT_CONFIG_NOSYSTEM=1`・`GIT_CONFIG_GLOBAL=/dev/null`・`HOME` は一時ディレクトリ（ホストのユーザーの設定・認証の補助を使わない）。`GIT_TERMINAL_PROMPT=0`
  - 作成者とコミッターは App のボット（`<slug>[bot]` と `<id>+<slug>[bot]@users.noreply.github.com`）。`GIT_AUTHOR_*`・`GIT_COMMITTER_*` の環境変数で渡す
- **作業ディレクトリの `.git/config`**: 007 の clone でホストが作り、作業場からは読み取り専用（003）なので、エージェントはフィルターや認証の補助を書き込めない。`.gitattributes` のフィルターは `.git/config` に定義がないと動かない。それでも上の設定で、ホストのユーザーの設定とフックの両方を外す（FR-009）
- **基準のコミット**: 007 の clone は `--depth 1` なので、作業ブランチの親は既定のブランチの先頭（clone した時点）の1つだけ。commit の親もそれになる
- **メッセージ**: 1行目は PR の題（R6）。本文に計画の概要、`Refs #<issue>`、`Factory-Job: <id>`
- **代替**: 005 の `gitDiffSource` の diff を `git apply` で別の作業ディレクトリに当てる → 同じ変更を2回作るだけ。作業ディレクトリをそのまま commit すれば、判定した diff と一致する

## R3. 出荷前チェックの対象と順番

- **決定**: commit を作ってから（push の前に）、`<基準>..HEAD` の1つの commit を対象に、次を順に評価する。すべて評価してから結論を出す（FR-002）
  1. 検査役の判定（005 が `passed` を返したことで満たす。`verdict.verdict == "pass"` を記録）
  2. diff の行数: `git diff --numstat <基準> HEAD` の追加と削除の合計（バイナリは 0。005 の `parseNumstat`）≤ `[auto_merge] max_diff_lines`
  3. 禁止パス: `git diff --name-status -M <基準> HEAD` の全パス（名前の変更・コピーは両方）を、`[auto_merge] forbidden_paths` に `posix.matchesGlob`（003 の `[tools] deny_write_paths` と同じ判定）で当てる
  4. 秘密情報: R4
  5. ラベル: PR を作る直前に Issue を取り直し、`[auto_merge] skip_label`（既定 `no-auto-merge`）があるか。取れなければ満たさない
  6. 作業の種類: `plan.work_type` が `[auto_merge] allowed_work_types` に含まれる。計画がない（渡された計画で回した）ときは満たさない
- **push しない条件**（Draft にもしない）: 4 で見つかった・スキャンできなかった（`secret_detected`）、3 のうち `.github/workflows/` の下のパスがある（`unshippable_change`）
- **理由**: commit の範囲で評価すれば、検査役が見た diff・出荷する内容・スキャンする内容が同じものになる
- **代替**: 005 の `PipelineResult.diff`（文字列）を解析する → 名前の変更やバイナリの扱いを自分で書くことになる。git に数えさせる

## R4. gitleaks の呼び方（対象リポジトリの側の許可を使わせない）

確かめた挙動（gitleaks 8.30.1）:

| 試したこと | 結果 |
|---|---|
| `--config` なしで `gitleaks git` | 作業ツリーの `.gitleaks.toml` を自動で読む。同じ commit で足した `[[allowlists]]` で、その commit の秘密情報が報告されなくなった（0 件・終了コード 0） |
| 行末に `// gitleaks:allow` を付けた本物の形のトークン | 報告されない |
| `--log-opts="nonexist..HEAD"`（範囲の誤り） | `ERR [git] fatal: ambiguous argument ...` を出したうえで `0 commits scanned` `no leaks found`、**終了コード 0** |
| `--log-opts="HEAD..HEAD"`（範囲が空） | `0 commits scanned`、終了コード 0 |
| 壊れた設定ファイル | `FTL unable to load gitleaks config`、終了コード 1 |
| 正しい範囲で秘密情報あり（`--exit-code 3`） | `1 commits scanned`、`leaks found: 1`、終了コード 3 |

- **決定**: 次の形で呼ぶ

  ```
  gitleaks git --no-banner --no-color --redact --exit-code 3
    --config <一時ファイル> --gitleaks-ignore-path <一時ディレクトリ>
    --log-opts "<基準>..HEAD" --report-format json --report-path <一時ファイル> <作業ディレクトリ>
  ```

  - 設定は**基準のコミットの** `.gitleaks.toml`（`git show <基準>:.gitleaks.toml`）を一時ファイルに書いて渡す。基準になければ `[extend] useDefault = true` だけの設定。`.gitleaksignore` も基準のコミットのものを一時ディレクトリに置く（なければ空のディレクトリ）。こうすると、エージェントが同じ変更で足した許可は効かない。対象リポジトリが元から持つ許可（テスト用の偽の値など）には従う（spec の Edge Cases）
  - 結果の判定: 終了コード 3 → 見つかった（報告の JSON から `File`・`StartLine`・`RuleID` だけを取る。`--redact` で `Secret` は伏せ字）。終了コード 0 **かつ**標準エラーに `1 commits scanned` がある **かつ** `ERR`・`FTL` の行がない → 見つからない。それ以外（終了コード 1、起動できない、時間切れ、走査した commit が1でない）→ スキャンできなかった
  - `gitleaks:allow`: commit の diff の追加行（`+` で始まる行）に `gitleaks:allow` を含むものがあれば、見つかったものとして扱う（規則の名前は `gitleaks-allow-comment`）。インラインの許可を無効にするフラグはないので、自分で確かめる
  - 時間の上限は 120 秒（ジョブの期限の残りが短ければそちら）
- **既定の禁止パスに足す**: `.gitleaks.toml`・`.gitleaksignore`。この commit のスキャンには効かないが、変えると CI の秘密情報スキャン（006 で `pnpm run secrets:scan`）の許可が変わるので、人間に見せる（Draft）
- **理由**: FR-003・FR-004。終了コードだけを見ると、範囲の誤りやスキャンの不具合を「秘密情報なし」と取り違えて push してしまう。原則 IV の「ガードはすり抜けられる前提」に合わせ、エージェントが変えられる場所（作業ツリーの設定・インラインの許可）を判定に使わない
- **代替**: `gitleaks dir` で変更したファイルを丸ごと調べる → 元からファイルにあった値（対象リポジトリの問題）まで拾い、ジョブの変更と区別できない。001 の `maskSecrets` のパターンで調べる → 規則が少なく、ローカル・CI・VPS と同じ版の gitleaks（006）でそろえる方針に合わない

## R5. push

- **決定**: `git push origin HEAD:refs/heads/<作業ブランチ>`（`--force` なし）。トークンは 007 の clone と同じく、環境変数（`GIT_CONFIG_COUNT`・`GIT_CONFIG_KEY_0=http.extraHeader`）で渡す。トークンは push の直前に `GitHubPort.getCloneAccess` で取り直す（インストールトークンは1時間で切れる。octokit がキャッシュと更新をする）。R2 と同じく、フックとホストの設定を外す
- **既にリモートにある作業ブランチ**: 強制しないので、リモートの履歴と食い違えば GitHub が拒否する（`non-fast-forward`）→ `ship_failed`
- **浅い clone からの push**: GitHub は受け付ける（親のコミットはリモートにある）
- **代替**: octokit の Git Data API（blob・tree・commit・ref を API で作る）→ 大きな変更やバイナリで呼び出しが増え、git の commit と内容がずれうる

## R6. PR と auto-merge

- **決定**:
  - 題: 計画の概要の1行目を 72 文字で切り詰めたもの。計画がなければ `Issue #<番号> への対応`
  - 作成: `POST /repos/{owner}/{repo}/pulls`（`head` は作業ブランチ、`base` は既定のブランチ、`draft` は振り分けで決める）。本文はまとめレポート（contracts/report.md）
  - auto-merge: GraphQL の `enablePullRequestAutoMerge(input: { pullRequestId, mergeMethod: SQUASH })`。マージの方法は squash に固定する（1つの commit なので、どの方法でも main の履歴は同じ形になる。設定は足さない）
  - 有効化の失敗（リポジトリで auto-merge が無効、ブランチ保護がない、マージ方法が許されていない など）: GraphQL の `convertPullRequestToDraft` で Draft に変え、GitHub のエラーの文（マスク済み）を振り分けの理由に足す（FR-015）。Draft への変更も失敗したら、PR はそのままにして「自動マージの状態を確定できなかった」と記録する
  - Draft を作れない（GitHub の無料プランの非公開リポジトリは Draft PR が使えず `422`）: 通常の PR として作り直し、auto-merge は有効にせず、レポートに「Draft にできないので通常の PR にした。auto-merge は有効にしていない」と書く
- **ブランチ保護がない場合**: GitHub は必須チェックのないリポジトリで auto-merge を有効にできない（すぐマージできる状態なら `enablePullRequestAutoMerge` が失敗する）ので、上の「有効化の失敗」で Draft になる。ファクトリーが自分でマージすることはない（FR-013）
- **理由**: 原則 VI。マージの判断は GitHub のブランチ保護に任せる
- **代替**: REST の `PUT /pulls/{n}/merge` でファクトリーがマージする → 独自のマージ判定になり、原則 VI に反する

## R7. App のボットの名前とメールアドレス

- **決定**: `GitHubPort.getBotIdentity()` を足す。本物は App の JWT で `GET /app`（`slug`）→ `GET /users/{slug}[bot]`（`id`）を呼び、`{ name: "<slug>[bot]", email: "<id>+<slug>[bot]@users.noreply.github.com" }` を返す。プロセスの中で覚える
- **理由**: FR-008。GitHub は noreply のアドレスで commit をボットのアカウントに結び付ける
- **代替**: `factory.toml` に書く → App を作り直すと食い違う。API で引けば設定が要らない

## R8. ジョブの状態と記録

- **決定**:
  - PR を作ったら、1つのトランザクションで `judging` → `pr_opened` → `ci_waiting` と移し、`jobs.pr_number` に番号を書く（001 の列。スキーマは変えない）。2つの遷移を1つにまとめるので、`pr_opened` のまま残ることはない
  - 振り分けは `job_events` の `note`（`{"kind":"shipped", "pr_number", "pr_url", "decision": "auto_merge" | "draft" | "unsettled", "conditions": [...], "notes": [...]}`）に残す。出荷前に止めたときは `{"kind":"ship_blocked", "conditions": [...]}` を残してから `failJob`
  - Issue への出荷の知らせは `{"kind":"ship_report_posted", "comment_url"}`。投稿の失敗は `error` の `{"kind":"ship_report_failed"}`
  - 起動時の掃除（`listInterruptedJobs`）の対象は 007 のまま `planning`〜`judging`。`ci_waiting` は対象にならないので、FR-019 はテストで確かめるだけにする。push のあと PR を作る前に止まったジョブは `judging` のまま残り、起動時に `restarted` で報告される（報告の作業ブランチの行は「push 済み」と書く）
- **理由**: スキーマを変えずに済む。009 は `pr_number` と `ci_waiting` で `check_suite` をジョブに結び付けられる
- **代替**: `jobs` に振り分けの列を足す → 009〜011 で集計するまで要らない。記事の集計は `job_events` の JSON で足りる

## R9. 失敗の分類の追加

- **決定**: `FailureKind` から `shipping_not_available` を消し、次を足す
  - `secret_detected`: 秘密情報が見つかった・スキャンできなかった（push しない）
  - `unshippable_change`: CI の定義を変えた（push しない）
  - `ship_failed`: commit・push・PR の作成に失敗した
- 停止の合図・期限は、push の前なら `stopped`・`timeout`。push を始めたら PR の作成まで続ける（FR-021。PR の作成は数秒で終わり、006 の停止の上限 70 秒に収まる。Worker の `stopTimeoutMs` 5 秒を過ぎたら、007 と同じく次の起動で `restarted` になる）
- **報告の作業ブランチの行**: push の前に止まったら 007 のとおり「push していません」、push のあとなら「push 済み」

## R10. 本物の GitHub での確認（AI解禁の前）

- **決定**: 開発用の CLI `pnpm run ship:dev`（`src/ship-dev.ts`）を足す。テスト用のリポジトリを 007 と同じ GitHub 層で clone し、渡したパッチを当て、偽の 005 の結果（合格、作業の種類は引数）を作って `shipJob` を呼ぶ。データベースは開発用（`--db`、既定は一時ファイル）。LLM は呼ばない
- **理由**: 常駐のファクトリーは さくら以外の提供元で起動しない（原則 I）。AI解禁の前に判定まで進められないので、出荷の工程だけを本物の GitHub（PR・auto-merge・Draft・ラベル）で試す道が要る。本体に「偽の工程」の切り替えを足すと、本番で誤って有効にする余地が残る
- **代替**: 常駐のファクトリーに偽の 005 の入口を差し込む環境変数 → 本番の起動経路に開発用の分岐が入る

## R11. まとめレポートの書き方

- **決定**: PR の本文（contracts/report.md）に、ジョブ番号、計画（概要・受け入れ条件・作業の種類）、テスト（最後の回の工程内テストの状態と実行回数）、判定（合否・理由・受け入れ条件ごとの結果）、やり直しの回数、消費したリクエスト数、変更（ファイル数と行数、ファイルの一覧は 50 件まで）、6つの条件の表、振り分けとその理由を書く。長い文は 2000 文字で切り詰め、本文全体を 60000 文字（GitHub の PR の本文の上限 65536 の手前）に収める。すべて `maskWith`（007）を通す
- Issue のコメントは短くする: PR へのリンク、振り分け（auto-merge 予約・Draft）、Draft なら満たさなかった条件、ジョブ番号、消費したリクエスト数
- **理由**: 原則 VI のレポートの要件。詳細は PR に1か所だけ書き、Issue からはリンクでたどる（009・010 で書き足す先も PR の本文にする）
