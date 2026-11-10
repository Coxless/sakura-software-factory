# 004 implementer-agent の実装

## やろうとしたこと

tasks.md の T001〜T042。Pi 1.5.0 の `Agent` に、002 の予算ゲート・003 の4ツールと検査・整形をつなぎ、コンテキストの圧縮・停止条件・steering・軌跡を足した。最後に Google AI Studio で `pnpm run implement:dev` を1回実行した。

## 想定と違ったこと

### 偽の LLM のツール呼び出しの id が固定だった

002 の `createFakeLlm` は、ツール呼び出しの id がいつも `call_fake_1` で、1つの応答に1つしか呼べなかった。004 では「どの toolResult を注記に置き換えたか」を `toolCallId` で記録するので、id が重なると軌跡から入力を復元できない。

→ `FakeResponse` に `toolCall.id` と `toolCalls`（1つの応答で複数）を足した。id を省いたときは従来どおり `call_fake_1` なので、002 のテストはそのまま通った。

### 偽の LLM の `hang` は既定で時間切れを発火させる

中断のテストで `{ hang: true }` を仕込んだら、`outcome` が `aborted` ではなく `failed` になった。

```
AssertionError: expected 'failed' to be 'aborted'
```

`createTestGateDeps` は `hang` の要求が届くと既定で「時間の上限」を発火させる（002 のタイムアウトのテスト用）。それでゲートが失敗を返していた。→ 004 のテストでは `onHang: () => {}` を渡し、中断が来るまで待たせた。

### 圧縮しても閾値をわずかに超える

圧縮のテストで、入力の見積もりが閾値を少し超えた。

```
AssertionError: expected 14008 to be less than or equal to 14000
```

条件は `contextWindow = 20000`・`compaction_ratio = 0.7`（閾値 14,000）・`keep_recent_turns = 4`。直近4ターンより前のツールの結果はすべて注記に置き換わっていた。超えた原因は2つある。

- 直近のターンは置き換えない設計
- 見積もりが Pi のメッセージの JSON 全体（`usage`・`api`・`model` などの付帯情報）を数えている

実際に LLM に送る量より多めに出るので、安全側のずれと判断した。テストは SC-006 の基準（コンテキストの上限 20,000 を超えない）で確かめる形にした。最初はツールの結果を 15,000 文字にしていたが、直近4ターンだけで閾値を超えていた（17,322）。これはテストの数字の誤りだった。

### `erasableSyntaxOnly` ではコンストラクタの引数プロパティが使えない

`StopTracker` を `constructor(private readonly limits: …)` で書いたら、型除去で実行する設定（001）に合わない。`#limits` のフィールドに書き直した。

### Workshop に作業場のイメージがなかった

`pnpm run check` で作業場のテスト（`*.docker.test.ts`）が44件飛ばされていた。Docker 自体は動いていて（29.1.3）、`factory-sandbox:latest` だけがなかった。`pnpm run sandbox:build` で作ったら、003 の分を含めて 378 件が通った。

### Workshop に sqlite3 がない

quickstart の `sqlite3 data/factory.dev.db '…'` が使えなかった。quickstart は `node -e` と better-sqlite3 で読む形に直した。

## Google AI Studio での手動実行（T041）

対象は本リポジトリ（公開）。Issue は「`src/trace/mask.ts` の `REDACTED` の直前に1行の JSDoc を足す」、計画は3行の手書き。

```
workshop exec dev -- env GEMINI_API_KEY=… FACTORY_CONFIG=factory.dev.toml sh -c '… pnpm run implement:dev -- --repo /project --issue /tmp/issue.md --plan /tmp/plan.md --max-turns 15 --timeout-minutes 10'
```

結果:

```
provider: google-ai-studio  model: gemini-3.5-flash-lite  job: 1
outcome: completed  turns: 9  requests: 9  tool calls: 8  blocked: 0
--- git diff --stat ---
 src/trace/mask.ts | 1 +
```

- 変更は意図どおりの1行（`/** 機密情報をマスクする際の置き換え文字列 */`）だけだった。元の `/project` は変わらず、作業場も残っていない
- 軌跡は 43,196 バイト。行の種類は `message` 17、`request` 9、`tool_result_meta` 8、`run_start` 1、`run_end` 1
- `agent_runs` の行（turns 9 / requests 9 / tool_calls 8）と結果の表示が一致した
- 入力の見積もり（トークン）の推移: 1722 → 2355 → 2719 → 3143 → 3672 → 10793 → 11708 → 12241 → 12666。6ターン目に `package.json` を読んで約 7,000 増えた。圧縮は起きていない（閾値は 131,072 × 0.7）

ツールの呼び出しの順:

```
read_file src/trace/mask.ts
edit_file src/trace/mask.ts
bash git diff
bash npm test
bash pnpm test
read_file package.json
bash npx tsc --noEmit
bash git diff
```

**9リクエストのうち4つは、テストを走らせようとして失敗した分だった。** clone した作業ディレクトリには `node_modules` がなく、作業場はネットワークなしなので、`pnpm test` も `npx tsc` も通らない。このリポジトリには AGENTS.md もないので、実装役はテストのコマンドを推測して試していた（`npm test` も試していて、pnpm のプロジェクトだと分かっていなかった）。最後のメッセージでは「ネットワーク環境制限のためテスト実行時のパッケージ解決はオフラインでブロックされました」と自分で報告していた。

→ 005 では、依存のインストール（003 の `installDependencies`）を実装工程の前に必ず行う。対象リポジトリに AGENTS.md（テストの実行方法）を置くことの効果は大きそう（`04` 3章の「対象リポジトリ側に置くもの」どおり）。012 の回帰評価でリクエスト数として比べる。

## まだ分かっていないこと

- 圧縮が実際のモデルでどう効くか（今回は起きなかった）。長いタスクで確かめる
- Kimi-K2.7-Code（さくら）で同じことが起きるか（AI解禁の後）
- 区切りの中の指示を無視させる書き方の効き目（今回の Issue には注入を入れていない）
