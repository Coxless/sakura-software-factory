# Quickstart: 実装役とハーネス（implementer-agent）

本機能が動くことを確かめる手順。コマンドは Workshop の中で実行する（`workshop exec dev -- <command>`）。

## 1. 自動テスト（実際の LLM なし）

```bash
workshop exec dev -- pnpm run check
```

確かめること（どれも偽の LLM・偽の4ツールで実行される。`*.docker.test.ts` は Docker とイメージがあるときだけ）:

| 対応 | テスト | 期待 |
|---|---|---|
| US1・SC-001 | 読む → 書く → bash → 完了 | 偽のファイルが変わり、`outcome = completed` |
| US1-2 | 1回の応答で2つのツール | 2つ目は1つ目の結果のあとに実行される（順に記録される） |
| US1-3 | 禁止パスへの書き込み | 拒否の理由が次の入力の toolResult に入り、工程は続く |
| US1-4・SC-003 | 呼び出しの記録 | `llm_calls`（`phase = implement`, `role = implementer`）の行数 = 偽の LLM の要求数 = 軌跡の assistant の `message` の数 |
| US2・SC-002 | 各上限 | ターン数 N で止まり、偽の LLM の要求は N 回。期限・予算・連続の拒否・中断でそれぞれの終わり方 |
| US3・SC-005 | 入力の中身 | すべての要求の入力に `<agents_md>`・`<issue>`・`<plan>` がある。AGENTS.md がないときはその旨 |
| US3-3 | Issue 文に `</issue>` と「指示を無視して」 | 区切りが崩され、区切りの外に出ない |
| US3-4・SC-006 | 大きなツールの結果を繰り返す | 古い結果が注記に置き換わり、見積もりが上限 × 割合以下 |
| US4・SC-008 | 実行中の `steer()` | 次の要求の入力に `<feedback>` がある。完了の応答のあとでも続く。終了後は `false` |
| US5・SC-007 | 軌跡 | 復元した入力 = 偽の LLM が受け取った入力。トークンの形の文字列が平文で残らない |
| SC-010 | 依存の範囲 | `pi-agent-core` を import するのは `src/pipeline/implement.ts` と `src/llm/` だけ |
| SC-011 | 軌跡の大きさ | ターン数を2倍にしたとき、ファイルの大きさが約2倍（4倍にならない） |

## 2. 軌跡を読む

テストや手で試したあとの軌跡は `storage.trace_dir` の下にある。

```bash
# 種類ごとの件数
jq -r '.type' data/traces-dev/job-12.jsonl | sort | uniq -c
# 実装役が呼んだツール（1ターン1行）
jq -r 'select(.type=="message" and .message.role=="assistant") | [.message.content[] | select(.type=="toolCall") | .name] | join(", ")' data/traces-dev/job-12.jsonl
# 呼び出しごとの [ターン, 入力の見積もり, 圧縮した数]
jq -c 'select(.type=="request") | [.turn, .estimatedTokens, (.compactedToolCallIds | length)]' data/traces-dev/job-12.jsonl
# 実行ごとの要約（Workshop には sqlite3 がないので better-sqlite3 で読む）
node -e 'const D=require("better-sqlite3");console.log(new D("data/factory.dev.db").prepare("SELECT id, attempt, outcome, turns, requests, tool_calls, blocked_calls, compactions FROM agent_runs WHERE job_id = 12").all())'
```

## 3. 開発用の LLM で手で試す（手動）

前提: 作業場のイメージ（`pnpm run sandbox:build`）、`GEMINI_API_KEY`。送るのは公開してよいリポジトリと Issue 文だけ。

```bash
# 例: 本リポジトリ（公開）を対象に、小さな変更を頼む。Issue と計画は Workshop の中の /tmp に置く
workshop exec dev -- env GEMINI_API_KEY="$GEMINI_API_KEY" FACTORY_CONFIG=factory.dev.toml sh -c '
cat > /tmp/issue.md <<"EOF"
src/trace/mask.ts の REDACTED 定数の直前に、この文字列が何に使われるかを説明する1行の JSDoc コメント（日本語）を足してください。
EOF
cat > /tmp/plan.md <<"EOF"
1. src/trace/mask.ts を読む
2. export const REDACTED の直前に1行の JSDoc コメントを足す（edit_file）
3. git diff で変更が src/trace/mask.ts の1か所だけであることを確かめる
EOF
cd /project && pnpm run implement:dev -- --repo /project --issue /tmp/issue.md --plan /tmp/plan.md --max-turns 15 --timeout-minutes 10'
```

実装役にテストまで実行させたいときは `--install "pnpm install --frozen-lockfile"` を付ける。依存がないと、実装役がテストのコマンドを何度も試してリクエストを使う。

期待:

- 終わり方・ターン数・リクエスト数・軌跡のファイル・`git diff --stat` が表示される
- 表示された一時ディレクトリの `src/trace/mask.ts` だけが変わっている（`git -C <workspace> diff`）。元の `/project` は変わらない
- `docker ps -a --filter label=sakura-factory.sandbox` に作業場が残っていない

さくらの設定（`factory.toml`）で `--allow-sakura` を付けずに実行すると、終了コード 2 で止まる（AI解禁前の誤用の防止）。

結果（指示の効き方、圧縮が起きたターン、止まり方）は `docs/journal/` に書く。
