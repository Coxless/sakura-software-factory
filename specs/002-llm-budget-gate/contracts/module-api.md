# Contract: 後続の機能に渡すモジュール

004（実装役）・005（計画役・検査役）・007（受付と状態機械）・012（回帰評価）が import する関数と型。シグネチャは目安で、名前と役割をこの形で固定する。

## `src/llm/provider.ts`

```ts
const SAKURA_PROVIDER_ID = "sakura";
const SAKURA_API_KEY_ENV = "SAKURA_AI_API_KEY";
const GOOGLE_AI_STUDIO_API_KEY_ENV = "GEMINI_API_KEY";
const LLM_PROVIDERS: Record<"sakura" | "google-ai-studio", { id; name; apiKeyEnv }>;

function providerOf(config: FactoryConfig): LlmProvider;       // [llm].provider の提供元
function apiKeyEnvOf(config: FactoryConfig): string;           // その APIキーの環境変数名
function assertProductionProvider(config: FactoryConfig): void; // sakura 以外なら例外。main.ts の起動時に呼ぶ（原則 I）
const DEFAULT_SAKURA_COMPAT: OpenAICompletionsCompat; // research R3。スモークテストの結果で直す

function createLlmModels(config: FactoryConfig, options?: { compat?: Partial<OpenAICompletionsCompat> }): Models;
// 設定の提供元（既定は さくら）を登録した Models。factory.toml の [models] の全モデルを持つ

function modelForRole(models: Models, config: FactoryConfig, role: LlmRole): Model<"openai-completions">;
// 役割 → factory.toml のモデル名 → Model。退避先への自動切り替えはしない
```

## `src/llm/budget.ts`

```ts
class BudgetExceededError extends Error {
  readonly scope: "monthly" | "job";
  readonly limit: number;
  readonly used: number;
}

function checkBudget(db: Db, config: FactoryConfig, jobId: number | null, now: number): BudgetExceededError | undefined;
// 月（設定のタイムゾーン）→ ジョブの順に確かめる。足りていれば undefined

function canAcceptNewJob(db: Db, config: FactoryConfig, now: number): { accept: boolean; remaining: number };
// remaining = monthly_requests − 今月の消費。accept = remaining >= per_job_requests

function ensureBudgetMonth(db: Db, config: FactoryConfig, now: number): void;
// その月の budget 行を用意する（なければ作る）
```

## `src/llm/stream.ts`

```ts
interface CallContext { jobId: number | null; phase: string; role: LlmRole }

interface GateDeps {
  db: Db;
  config: FactoryConfig;
  models: Models;                       // createLlmModels の結果（テストでも本物を使う）
  logger: Logger;
  apiKey?: string;                      // 省くと提供元の認証（環境変数 SAKURA_AI_API_KEY）。エラー文のマスクにも使う
  now?: () => number;                   // テスト用
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; // テスト用（待たずに進める）
  fetch?: typeof fetch;                 // ネットワークの手前。既定は globalThis.fetch、テストでは偽の fetch
  timeoutSignal?: (ms: number) => AbortSignal; // 試行ごとの時間の上限。既定は AbortSignal.timeout、テストでは手動で中止できる signal
}

function createGatedStreamFn(deps: GateDeps, ctx: CallContext): StreamFn;
// pi-agent-core の StreamFn。予算の確認 → 試行 → 記録 → 必要なら再試行。
// 成功時は溜めたイベントを流す。失敗時は error イベント1つ（途中までの応答は流さない）

function runGated<T>(deps: GateDeps, ctx: CallContext, model: string,
                     attempt: (signal: AbortSignal, fetchFn: typeof fetch) => Promise<AttemptOutcome<T>>,
                     options?: { signal?: AbortSignal }): Promise<T>;
// ゲートの中核。StreamFn と素の HTTP（スモークテスト）の両方が使う。失敗時は例外
// （BudgetExceededError か LlmCallError）

class LlmCallError extends Error { readonly kind: "transient" | "permanent" | "timeout" | "aborted"; readonly attempts: number; readonly httpStatus: number | undefined }

function getBudgetExceeded(message: AssistantMessage): BudgetExceededError | undefined;
// ゲートが返した最終メッセージが予算切れなら取り出す（007 が failed への遷移に使う）

function installStreamFnGuard(): void;
// setDefaultStreamFn に「ゲートを通さずに呼ばれたら例外」を設定する。main.ts とスモークテストの起動時に呼ぶ
```

### 振る舞いの約束
- 試行の前に毎回 `checkBudget` を呼ぶ。予算切れなら LLM に送らず、記録もしない
- 試行1回につき `llm_calls` に1件だけ書く。記録に失敗したら呼び出し全体を失敗にする
- 内側の呼び出しには常に `maxRetries: 0` と、ゲートの `fetch`・`signal`・`timeoutMs` を渡す
- 再試行の判定・待ち時間は research R5・R6。最大試行回数は `[llm].max_attempts`
- エラー文は `maskSecrets` と APIキーの値の置き換えを通してから記録・返却する

## `src/llm/testing.ts`（テスト専用）

```ts
type FakeResponse =
  | { text: string; usage?: { input: number; output: number } }
  | { toolCall: { name: string; args: Record<string, unknown> }; text?: string; usage?: { input: number; output: number } }
  | { httpError: number; retryAfterSeconds?: number; body?: string; headers?: Record<string, string> } // 429・500・401 など
  | { networkError: string }                                            // 接続失敗（fetch が投げる）
  | { midStreamError: string }                                          // 200 のあと途中で切れる
  | { hang: true };                                                     // 応答せず、signal の中止を待つ（タイムアウト・取り消し）

function createFakeLlm(responses: FakeResponse[]): {
  fetch: typeof fetch;                 // GateDeps.fetch に渡す。OpenAI互換の SSE / JSON を返す
  requests: { model: string; messages: unknown[]; tools?: unknown[]; stream: boolean }[]; // 受け取った要求
  remaining(): number;
};
// 仕込みが尽きたら fetch が "fake LLM: no more responses" の例外を投げる

function createTestGateDeps(options: { responses?: FakeResponse[]; config?: TestConfigOverrides; onHang?: () => void }): {
  deps: GateDeps;                      // :memory: の DB（マイグレーション済み）、本物の createLlmModels、偽の fetch、待たない sleep、手動で発火できる timeoutSignal
  fake: FakeLlm;
  db: Db; sqlite: Database; close(): void;
  sleeps: number[];                    // sleep に渡った待ち時間
  fireTimeout(): void;                 // 試行中の時間の上限を発火する（{ hang: true } が届くと既定で自動的に呼ばれる）
  setNow(value: number): void;
};
```

## `src/llm/budget.ts`（追加）

```ts
function parseBudgetExceeded(message: string | undefined): BudgetExceededError | undefined; // budget_exceeded:... の文字列から復元
```

## `src/llm/smoke.ts`

```ts
type SmokeMode = "pi" | "raw" | "raw-nostream";
function runSmoke(deps: GateDeps, options: { role: ModelRole; mode: SmokeMode; compat?: Partial<OpenAICompletionsCompat> }): Promise<SmokeReport>;
// 呼び出しの失敗（予算切れ・恒久的なエラー・再試行の上限）は SmokeError（requests 付き）
```

## `src/smoke-llm.ts`

```ts
function runSmokeCli(argv: string[], env: NodeJS.ProcessEnv, io: SmokeCliIo): Promise<number>; // 終了コード 0 / 1 / 2
```
