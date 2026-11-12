# Research: 計画・工程内テスト・判定（local-pipeline）

Technical Context に未確定の項目はない。以下は、設計の選択とその根拠。

## R1. 計画役・検査役の1回呼び出しの経路

- **Decision**: `src/llm/complete.ts` に「ツールなしの1回呼び出し」を置く。中身は 002 の `createGatedStreamFn` をそのまま使い、`context` に `tools` を入れずに `systemPrompt` と `messages` だけを渡して `stream.result()` を待つ（スモークテストの `piSender` と同じ形）。入口と結果の型は Pi の型を含まない（`{ text, stopReason, error, budgetExceeded }`）
- **Rationale**: 原則 V（ゲートを経由しない経路を作らない）と原則 III（`tools` 自体を渡さない）を1か所で守れる。Pi の型を `llm/` の中に閉じ込めるので、TanStack AI へ切り替えるときの書き直しは `llm/` と `pipeline/implement.ts` のままで増えない（実装計画1章）
- **Alternatives considered**: pi-agent-core の `Agent` をツールなしで使う → 1回呼び出しにはループと停止条件が余計で、Pi を import するファイルが増える。pi-ai の `complete` を直接呼ぶ → ゲートを通らない経路になる（原則 V 違反）

## R2. 計画役・検査役の出力の取り出しと検証

- **Decision**: `src/harness/structured.ts` に共通の仕組みを置く。(1) 出力からコードブロックの囲み（```json）を外し、全体を `JSON.parse` できなければ、文字列の中を考慮して括弧を数え、最初の JSON オブジェクトを取り出す。(2) TypeBox のスキーマで `Value.Check`、合わなければ `Value.Errors` を「パス: 理由」の短い一覧にする。(3) 1回目が合わなければ、会話に「前回の出力（assistant）」と「合わなかった点と、JSON だけを返すように求める user メッセージ」を足して1回だけ再要求する。2回目も合わなければ失敗
- **Rationale**: さくらは `response_format` を無視する（`03` 6章）ので、プロンプトで JSON を出させてこちらで検証する（原則 III）。前後に説明文を付けるモデルは多いので、取り出しで救えるものは再要求に回さない（リクエストの節約）。スキーマは余分な項目を許す（`additionalProperties` を禁じない）。足りない・型が違う、だけを再要求の対象にする
- **Alternatives considered**: 正規表現で `{...}` を抜く → 文字列の中の括弧で崩れる。`response_format` に頼る → さくらでは効かない。2回目の失敗で既定値を補う → 原則 III の「検証」を骨抜きにする

## R3. 計画の形と作業の種類

- **Decision**: 計画は `{ summary, steps[], acceptance_criteria[], work_type }`。`work_type` は `bugfix | test | docs | refactor | feature | chore` のどれか（`src/pipeline/plan.ts` の `WORK_TYPES`）。実装役には、これを見出し付きの文章（概要・作業手順・受け入れ条件・作業の種類）にして渡す（004 の `plan: string` はそのまま）。CLI の `--plan` で渡したファイルは文章のまま実装役に渡し、検査役にもそのまま渡す（この場合 `work_type` は不明＝`undefined`）
- **Rationale**: 受け入れ条件を検査役に渡す材料にし、`work_type` を 008 の「作業の種類が許可リスト内」の条件に使う（原則 VI）。`[auto_merge].allowed_work_types` の既定（bugfix・test・docs・refactor）は `WORK_TYPES` の部分集合なので、設定の検証で「`WORK_TYPES` にない値」を誤りにする
- **Alternatives considered**: 計画を自由な文章にする → 受け入れ条件と作業の種類を後から取り出せない。作業の種類を検査役に決めさせる → 実際の diff を見て決められる利点はあるが、判定の出力が大きくなり、合否と種類の2つを1つの再要求で直すことになる。008 の出荷前チェックが diff の大きさ・禁止パスを別に見るので、計画時点の種類で足りる

## R4. 工程内テストを差し込む時点（004 への追加）

- **Decision**: 004 の `ImplementerInput` に任意の `onComplete?(signal) => Promise<string | undefined>` を足す。`finishTurn` で「ツールを呼ばず、差し込みもない（＝完了を告げた）」ときに await し、文字列が返れば `agent.steer()` で差し込んで `{ action: "continue" }`（ターン数の上限は数え続ける）、`undefined` なら従来どおり完了で終わる。差し込んだ内容は 004 の `steer` と同じく軌跡に `steer` として残す。`ImplementerResult` に `completionChecks`（`onComplete` を呼んだ回数）を足す
- **Rationale**: Pi 1.5.0 の `FinishTurn` は Promise を返せて signal を受け取る（`types.d.ts` の `FinishTurn`）。同じ会話の中で失敗を戻せ（`04` 3章「フィードバック（工程内）: steering キュー」）、テストの実行中も期限・中断の signal が効く。工程内テストの中身（コマンド・回数）は 005 の側に置き、004 は「完了の時点で呼ぶ口」だけを持つ（Pi の型は出さない）
- **Alternatives considered**: 実装工程が終わってからテストし、失敗したら新しい会話でやり直す → 会話の文脈（何を変えたか）を失い、1回ごとに計画・AGENTS.md の入力を払い直す。外から `steer()` を呼ぶ → 完了の瞬間に割り込めず、競合する。`getFollowUpMessages` を使う → テストを走らせる間の signal と、上限の判定（`finishTurn` の `end`）を同じ場所で扱えない

## R5. 工程内テストの実行

- **Decision**: `[pipeline].check_commands`（既定 `["pnpm run check"]`）を、作業場の中で `sh -c <command>` として順に実行する。`Workspace` に `exec(command, { timeoutMs, signal })` を足し（本物は 003 の `Sandbox.exec`、偽物は 004 の偽の作業場の `bash` の振る舞いを流用）、結果は `{ exitCode, output, timedOut, durationMs }`。最初に失敗したコマンドで止める。時間の上限は `min([pipeline].check_timeout_seconds, 期限までの残り)`。終了コード 126・127（起動できない）と作業場の異常は「テスト失敗」ではなく工程全体の失敗にする。ログは標準出力と標準エラーをつなげ、秘密情報を伏せてから `[pipeline].max_check_log_chars` で先頭と末尾を残して切り詰める（003 の `truncateMiddle`）
- **Rationale**: 原則 VI「工程内検査は決まったコマンドで実行する」と `04` 3章「CI とファクトリー内テストのコマンドをそろえる」。対象リポジトリのファイルからコマンドを読まないので、Issue やリポジトリの中身で実行内容を変えられない。作業場はネットワークなしのまま（依存は準備の工程で入れてある）
- **Alternatives considered**: 実装役の `bash` ツールの経路で走らせる → 検査（層3）の拒否や整形の対象になり、モデルの呼び出しと区別がつかない。「関係するテストだけ」を選ぶ → 選び方がリポジトリごとに違い、CI との差が広がる

## R6. diff の取り出し

- **Decision**: ホストで git を使う（`src/pipeline/diff.ts`）。工程の開始時に `git rev-parse HEAD` を基準として覚え、取り出すときは一時的なインデックス（`GIT_INDEX_FILE` を一時ファイルにし、`git read-tree <基準>` → `git add -A`）を作って `git diff --cached <基準>` と `--numstat` を取る。作業ディレクトリのインデックスと作業ツリーは変えない。テストでは偽の取り出し（偽の作業場のファイルと初期の内容の差）を渡す
- **Rationale**: 追跡していない新しいファイルも diff に入る（FR-022）。`.git` は作業場の中では読み取り専用（003）だが、ホストからは書ける。コンテナの中で git を走らせないので、作業場が壊れていても取り出せる
- **Alternatives considered**: `git add -N` で本当のインデックスに印を付ける → 008 の commit と干渉する。`git status --porcelain` と各ファイルの読み込み → バイナリ・改名の扱いを自前で書くことになる

## R7. 工程の流れと終わり方

- **Decision**: `src/pipeline/run.ts` の `runPipeline` に決め打ちで書く。

  ```
  plan（計画を渡されたら飛ばす）
  for round = 1 .. judge_retries + 1:
    implement（onComplete で工程内テスト。失敗なら差し込み、上限まで）
      completed → テストが通った? → diff が空でない? → judge
      max_turns / blocked_repeatedly → 不合格（その理由）
      failed → 失敗で終了 / budget_exceeded・timeout・aborted → そのまま終了
    judge 合格 → passed で終了
    不合格 → 理由と今の diff を feedback にして次の round
  使い切ったら rejected
  ```

  終わり方は `passed | rejected | failed | budget_exceeded | timeout | aborted`。期限は `AbortController` 1つにまとめ（呼び出し側の signal と期限のタイマー）、どちらで止まったかを旗で見分ける。工程の境目は `onPhase("planning" | "implementing" | "testing" | "judging")` で知らせる。工程内テストで失敗を差し込んだあとは `"implementing"` に戻る
- **Rationale**: 原則 II（工程の遷移をコードで決め、すべての反復に上限）。やり直しは作業ディレクトリを戻さず新しい会話で始める（004 の決定と spec の Clarifications）。`onPhase` の名前を 007 の `JobStatus` に合わせ、007 は受け取った名前で状態を進める
- **Alternatives considered**: 状態を `jobs` に直接書く → 007 の状態機械と二重になる（状態を進めるのは 007 だけにする）

## R8. 状態機械の `testing → implementing`

- **Decision**: `03` 3章の状態機械に「`testing` ──(工程内テストの失敗)──▶ `implementing`」を足す（同じ変更で設計ドキュメントを直す）。上限は `[pipeline].max_check_feedbacks`（1回の実装工程あたり）
- **Rationale**: `03` 4章 #5 の「失敗は steering で実装役に戻す」を状態として表す。007 の遷移表が `testing → implementing` を許すように、007 の plan を合わせる（007 はまだ main に入っていない）
- **Alternatives considered**: `testing` を状態として知らせない → 007 の状態と `03` 3章の図が合わなくなる

## R9. 軌跡と要約

- **Decision**: 計画役・検査役の各回を `agent_runs` に1行ずつ（`phase` は `plan`／`judge`、`turns` は呼び出し回数、`tool_calls` は 0）記録し、詳細は同じジョブの JSONL に `llm_request`（システムの指示と user メッセージ）・`message`（応答）・`validation`（検証の結果と合わなかった点）を書く。工程全体の判断は `run = 0`・`phase = "pipeline"` の行として `pipeline_start`・`check_run`（コマンド・終了コード・時間・打ち切りの有無・切り詰めたログ）・`round_end`（回の結果と次の動き）・`pipeline_end` を書く。判定の合否は `agent_runs` に新しい列 `verdict`（`pass`／`fail`、判定以外は NULL）として持つ（マイグレーション `0003`）
- **Rationale**: 原則 V（軌跡は JSONL、要約は SQLite。入力を復元できる）。1回呼び出しの入力は `llm_request` と再要求のときの追加の2件で復元できる。`agent_runs` を使い回せば、011 の `/status` と記事の SQL で「工程ごとのリクエスト数」がそのまま集計できる。判定の合否は記事の柱（検査役の比較・回帰評価）なので SQL で数えられるようにする
- **Alternatives considered**: 判定専用の表を作る → 012 までは列1つで足りる（YAGNI）。合否を `error` 列などに混ぜる → 集計できない

## R10. 計画役・検査役に渡す入力

- **Decision**: 区切りのタグでデータを囲み、閉じタグを崩す（004 の `escapeDataBlock` を使い回し、`DATA_TAGS` に `instruction`・`files`・`diff`・`checks` を足す）。
  - 計画役: `issue`（タイトルと本文）・`instruction`（依頼の本文）・`agents_md`・`files`（ホストで `git ls-files` の一覧を `[pipeline].max_file_list_chars` で切り詰め）
  - 検査役: `issue`・`instruction`・`plan`（受け入れ条件を含む文章）・`diff`（`[pipeline].max_diff_chars` で切り詰め）・`checks`（最後の工程内テストのコマンドと結果の要約）
  - それぞれの上限は 004 の `[implementer]` の `max_issue_chars`・`max_agents_md_chars`・`max_plan_chars` を使い回す
- **Rationale**: 原則 IV（Issue 文・リポジトリ内のファイル・ログはデータ）。実装役と同じ区切りの書き方にそろえると、プロンプトを直すときの見通しがよい
- **Alternatives considered**: ファイルの中身まで計画役に渡す → 入力が大きくなり、1回呼び出しの利点（安い・速い）を失う。中身が要るなら実装役がツールで読む

## R11. 検査役と実装役のモデルの区別

- **Decision**: 工程を始める前に `[models].verifier` と `[models].implementer` が同じ文字列なら、LLM を呼ばずに `failed`（原則 III のため設定を直すよう求める）で終える。設定の読み込み（`config.ts`）では誤りにしない（スモークテストなど工程を回さない用途があるため）
- **Rationale**: 名前が同じなら確実に同じモデル。系統の違い（Kimi と Qwen）までは名前から判断できないので、そこは設定のコメントと憲章に任せる
- **Alternatives considered**: 設定の検証で拒む → 001〜004 のテストの設定が軒並み直しになり、工程を回さないコマンドまで止まる

## R12. CLI（`pipeline:dev`）

- **Decision**: `src/pipeline-dev.ts`（`pnpm run pipeline:dev`）。004 の `implement-dev.ts` の作り（引数の解析、`--allow-sakura`、`git clone --local` で複製、`installDependencies`、`createSandbox`、`jobs` に1行、`--json`、テスト用の差し替え口）を引き継ぎ、`--plan` を任意にし、`--instruction`（依頼の本文のファイル）を足す。`implement-dev.ts` とその script は削除する。終了コードは `0`: passed、`1`: rejected、`2`: 実行前の失敗、`3`: failed・budget_exceeded・timeout・aborted。SIGINT で中断し、作業場を片付けてから終わる
- **Rationale**: spec の Clarifications（`implement:dev` を統合）。実装工程だけを試す使い方は `--plan` で残る（計画役は呼ばれないが、工程内テストと判定は回る）
- **Alternatives considered**: `implement:dev` を残す → 同じ準備のコードが2つになる

## R13. 設定の追加（`[pipeline]`）

- **Decision**:

  | 項目 | 既定 | 範囲 |
  |---|---|---|
  | `check_commands` | `["pnpm run check"]` | 0件以上（0件なら工程内テストを飛ばし、起動時に警告） |
  | `check_timeout_seconds` | 600 | 10〜3600 |
  | `max_check_feedbacks` | 3 | 0〜10 |
  | `max_check_log_chars` | 8000 | 1000〜100000 |
  | `max_diff_chars` | 40000 | 1000〜400000 |
  | `max_file_list_chars` | 10000 | 1000〜100000 |

  判定不合格のやり直しの上限は既存の `[limits].judge_retries`、ジョブの期限は `[limits].job_timeout_minutes` を使う。値は仮の値で、012 と AI解禁後の調整で直す
- **Rationale**: 工程内テストのコマンドをリポジトリの外（ファクトリーの設定）に置く（spec の Clarifications）。既存の項目と重ならないものだけを足す
