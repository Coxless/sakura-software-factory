# Contract: 後続の機能に渡すモジュール

002 以降が import する関数と型。シグネチャは目安で、名前と役割をこの形で固定する。

## `src/config.ts`

```ts
type FactoryConfig = Readonly<Static<typeof FactoryConfigSchema>>; // 形は factory-toml.md

class ConfigError extends Error { readonly issues: readonly { path: string; message: string }[] }

function loadConfig(path?: string): FactoryConfig;   // 既定は FACTORY_CONFIG か ./factory.toml。失敗時は ConfigError
function parseConfig(tomlText: string, baseDir: string): FactoryConfig; // テスト用。ファイルを読まない
function requireEnv(name: string): string;            // なければ名前を含むエラー
```

## `src/log.ts`

```ts
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
function createLogger(options: { level: LogLevel }, destination?: DestinationStream): Logger; // pino の Logger。config.ts に依存しない（main.ts で config.log を渡す）
// 文脈付き: logger.child({ job_id })
```

## `src/trace/mask.ts`

```ts
function maskSecrets(text: string): string; // 既知の秘密情報の形を [REDACTED] に置き換える（004 の軌跡でも使う）
```

## `src/queue/db.ts`

```ts
type Db = BetterSQLite3Database<typeof schema>;

function openDatabase(path: string): { db: Db; sqlite: Database; close(): void }; // ":memory:" 可。WAL などの PRAGMA を設定
function runMigrations(db: Db, migrationsFolder?: string): void;  // 未適用分だけ。既定のフォルダーは drizzle/（テストで差し替える）。失敗時は変更を残さず例外
```

## `src/queue/schema.ts`

Drizzle のテーブル定義 `jobs`, `jobEvents`, `llmCalls`, `deployments`, `budget` と、

```ts
const JOB_STATUSES = ["queued", "planning", ..., "failed"] as const;
type JobStatus = (typeof JOB_STATUSES)[number];
const LLM_ROLES = ["planner", "implementer", "verifier"] as const;
```

## `src/queue/jobs.ts`

```ts
function claimNextQueuedJob(db: Db, now: number): Job | undefined; // queued → planning を1件だけ。二重に取らない
```

## `src/queue/llm-calls.ts`

```ts
function countLlmCallsInMonth(db: Db, now: number, timeZone: string): number;
function countLlmCallsForJob(db: Db, jobId: number): number;
```

## `src/queue/month.ts`

```ts
function monthRange(now: number, timeZone: string): { key: string; start: number; end: number }; // key は "YYYY-MM"、start/end は UTC ミリ秒（end は翌月初、含まない）
```
