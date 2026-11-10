# 002 llm-budget-gate の実装

## やろうとしたこと

tasks.md の T001〜T036 のうち、実機を使わずにできる分（Phase 1・2、US1 の T015〜T018、US2〜US5、仕上げ）を実装した。実機のスモークテスト（T019・T020）は APIキーと正しい `base_url` が要るので、まだ実行していない。

結果: `pnpm run check` が通った（14ファイル・136テスト）。LLM 層のテスト（`src/llm` と `src/smoke-llm.test.ts`、78テスト）は 1.18 秒で、SC-006（10秒以内）を満たす。

## 想定と違ったこと

### pnpm add でビルドスクリプトが止められた

```
$ pnpm add @earendil-works/pi-ai@1.5.0 @earendil-works/pi-agent-core@1.5.0
Error: ERR_PNPM_IGNORED_BUILDS
  × adding a new package
  ╰─▶ Ignored build scripts: @google/genai@2.21.0, protobufjs@7.6.6
```

どちらも pi-ai の推移的な依存。中身を見ると、`@google/genai` の preinstall は `echo 'preinstall: no-op'`、`protobufjs` の postinstall は `node scripts/postinstall`。さくら（openai-completions）しか使わないので、`pnpm-workspace.yaml` の `allowBuilds` に `false` で明記して実行しないことにした。`package.json` に `^` `~` は付かず、`minimumReleaseAgeExclude` も足されなかった。

### drizzle-kit が生成したマイグレーションが、まだない列を SELECT していた

`llm_calls` に CHECK 付きの `error_kind` を足すと、SQLite は既存の表に CHECK を足せないので、drizzle-kit 0.31.11 は表を作り直す SQL を出す。その INSERT が次の形だった。

```sql
INSERT INTO `__new_llm_calls`(..., "status", "error_kind", "error", ...) SELECT ..., "status", "error_kind", "error", ... FROM `llm_calls`;
```

旧表には `error_kind` がないので、行が0件でも SQL として失敗する。data-model の取り決めどおり `CASE WHEN "status" = 'ok' THEN NULL ELSE 'permanent' END` に手で直した。0000 だけを当てた DB に `ok` と `error` の行を入れてから 0001 を当てると、`[{status:'ok', error_kind:null}, {status:'error', error_kind:'permanent', error:'boom'}]` になることを確かめた。

### pi-agent-core 1.5.0 は、もともと既定の streamFn が「なし」

`getDefaultStreamFn()` は未設定なら `No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().` を投げる。さらに `AgentOptions.streamFn` は型の上で必須。つまり何もしなくても素通りはしない。それでも `installStreamFnGuard()` は残した。理由は、どこかが `setDefaultStreamFn()` で素の関数を入れたときの上書きと、「予算ゲートを通すこと」という明示的なメッセージのため。

`getDefaultStreamFn` はパッケージの入口（index）から export されていない（`exports` は `.` だけ）。そのためテストでは `new Agent({} as AgentOptions).streamFunction(...)` を呼んで、ガードの例外を確かめた。

### エラー文の形

- Pi は HTTP エラーを `formatProviderError` で `400: {"message":"...","type":"..."}` の形にする（`400 Bad Request: ...` ではない）。状態コードで始まるので、ゲートでは付け足さない
- 接続失敗のときは、OpenAI SDK が `fetch` の例外を `Connection error.` に包むので、元の原因（`ENOTFOUND` など）が `errorMessage` から消える。ゲートの観測用の fetch が捕まえた例外の文を `(cause: ...)` として付け足すようにした
- 送る前に失敗した場合（認証の設定がないなど）は fetch が呼ばれない。この場合は「応答がない」の `transient` ではなく `permanent` にした（観測用の fetch が呼ばれたかどうかで分ける）

### `models.streamSimple` と APIキー

`Models.streamSimple()` は遅延評価で、認証の解決（`envApiKeyAuth`）を内側で行う。`options.apiKey` を渡すとそちらが優先される。そこで `GateDeps.apiKey` を足し、テストでは `test-key-ABCDEF123` を渡すことにした。マスクにも同じ値を使う。アダプターの `streamSimple` を直接呼ぶと、キーがないときに同期的に例外になる（型のコメントのとおり）。ゲートは `Models` 経由でしか呼ばないので、この経路は通らない。

### pnpm は `--` をそのまま渡す

`pnpm run smoke:llm -- --raw` を実行すると、node には `-- --raw` が渡る（pnpm 12.18.0）。`parseArgs` は `--` のあとを位置引数として扱うので、先頭の `--` を取り除いてから解析するようにした。

### テスト用の設定

`testConfig({ budget: { monthly_requests: 1 } })` のように月の上限だけを下げると、既定の `per_job_requests = 100` が月の上限を超え、001 の相互検証（`per_job_requests <= monthly_requests`）で弾かれた。テスト用の設定では、`per_job_requests` を指定しないときは `min(100, monthly_requests)` にした。

## 進め方について

- 再試行のループ（T026・T027）は、T014 で `stream.ts` の中核を書くときに一緒に入れた。そのため、US3 のテスト（T025）は書いた時点で通った。テストを先に書いて失敗を確かめる手順は、このフェーズでは守れていない
- タイムアウトのテストは、analyze で決めた `GateDeps.timeoutSignal` の注入で、本物のタイマーを使わずに済んだ。`{ hang: true }` を仕込むと、要求が届いた時点で時間の上限が発火する

## まだ分かっていないこと

- さくらのAI Engine の正確な `base_url` とモデル名（`factory.toml` は仮の値のまま）
- 実機で、`stream_options.include_usage` によってトークン数が返るか。Kimi-K2.7-Code のツール呼び出しが構造化されて返るか（T019 で確かめる）
- 実機の 429 で `retry-after` が付くか、`x-should-retry` を返すか

## Chat Completions に限定した

さくらのAI Engine の無償枠で使えるのは Chat Completions だけだと分かった。そこで、憲法の原則 I を「OpenAI互換API（Chat Completions / Responses）」から「OpenAI互換の Chat Completions API。Responses API は使わない」に改めた（1.0.1 → 1.1.0）。使ってよい API を狭めて意味が変わるので、PATCH ではなく MINOR にした。`docs/design/01` と `CLAUDE.md` も同時に直した。実装（Pi の `openai-completions` アダプター、スモークテストの `--raw`）は、もともと Chat Completions だけを使っているので、変更はない。
