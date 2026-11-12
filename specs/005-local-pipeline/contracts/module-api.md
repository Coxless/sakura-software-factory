# Contract: 後続の機能に渡すモジュール（005）

007（Worker）・008（出荷）・012（回帰評価）が import する関数と型。シグネチャは目安で、名前と役割をこの形で固定する。
どの型も Pi の型を含まない。Pi を import するのは `src/pipeline/implement.ts`（pi-agent-core）と `src/llm/`（pi-ai）だけ。

## `src/pipeline/run.ts`（工程の入口）

```ts
type PipelineOutcome = "passed" | "rejected" | "failed" | "budget_exceeded" | "timeout" | "aborted";
type PipelinePhase = "planning" | "implementing" | "testing" | "judging";   // 007 の JobStatus と同じ名前

interface PipelineInput {
  jobId: number;
  workspace: Workspace;                 // 004 の Workspace（exec を足したもの）
  workdir: string;                      // ホストの作業ディレクトリ（git の作業ツリー）
  issue: { title: string; body: string };
  instruction?: string;                 // @agent のあとの依頼の本文
  plan?: string;                        // 渡したら計画役を飛ばす（CLI の --plan）
  deadline: number;                     // UTC の Unix ミリ秒
  signal?: AbortSignal;
  onPhase?: (phase: PipelinePhase, round: number) => void;   // 例外は握りつぶしてログに残す
}

interface PipelineDeps {
  gate: GateDeps;                       // 002
  now?: () => number;
  /** diff の取り出し。既定は git（diff.ts）。テストでは偽物 */
  diff?: DiffSource;
  /** ファイル一覧。既定は git ls-files。テストでは偽物 */
  listFiles?: (workdir: string) => Promise<string[]>;
}

interface PipelineResult {
  outcome: PipelineOutcome;
  plan?: Plan;                          // 計画役の出力（渡された計画なら undefined）
  planText: string;
  verdict?: Verdict;                    // 最後の判定
  reason: string;                       // 最後の不合格・失敗の理由（マスク済み）
  rounds: RoundSummary[];
  retries: number;
  requests: number;
  diff: string;                         // 最後の diff（008 の出荷前チェック用。マスクしない）
  diffStat: DiffStat;
  error?: string;
  tracePath: string;
}

/** 例外で reject しない */
function runPipeline(deps: PipelineDeps, input: PipelineInput): Promise<PipelineResult>;

/**
 * 007 の PipelinePort の形: 作業ディレクトリから作業場を作り、runPipeline を回して片付ける。
 * 作業場の作成に失敗したら outcome "failed"
 */
function runPipelineInSandbox(
  deps: PipelineDeps,
  input: Omit<PipelineInput, "workspace">,
): Promise<PipelineResult>;
```

## `src/pipeline/plan.ts`・`src/pipeline/verify.ts`

```ts
/** 定義は src/config.ts（設定の検証で使うため）。plan.ts は re-export する */
const WORK_TYPES = ["bugfix", "test", "docs", "refactor", "feature", "chore"] as const;
type WorkType = (typeof WORK_TYPES)[number];

const PlanSchema;      // TypeBox。data-model.md 3章
type Plan = Static<typeof PlanSchema>;
const VerdictSchema;   // TypeBox
type Verdict = Static<typeof VerdictSchema>;

/** 計画を文章にする（実装役・検査役に渡す） */
function planToText(plan: Plan): string;

type OneShotOutcome<T> =
  | { kind: "ok"; value: T; requests: number; runId: number }
  | { kind: "invalid"; errors: string[]; requests: number; runId: number }   // 2回とも形が合わない
  /** failed: LLM の失敗・軌跡に書けない など */
  | { kind: "failed" | "budget_exceeded" | "timeout" | "aborted"; error: string; requests: number; runId: number };

function makePlan(deps, input: { jobId; issue; instruction?; agentsMd?; files: string[]; signal }): Promise<OneShotOutcome<Plan>>;
function judge(deps, input: { jobId; issue; instruction?; planText; diff; checks: CheckSummary; signal }): Promise<OneShotOutcome<Verdict>>;
```

## `src/pipeline/checks.ts`（工程内テスト）

```ts
interface CheckResult {
  command: string;
  exitCode: number;          // 打ち切りは -1
  durationMs: number;
  timedOut: boolean;
  output: string;            // マスク・切り詰め後
  outputChars: number;       // 切り詰め前
}
type CheckRun =
  | { kind: "passed" | "failed"; results: CheckResult[] }
  | { kind: "skipped" }                                    // check_commands が空
  | { kind: "unavailable"; error: string };                // 126・127・作業場の異常

/** 設定のコマンドを順に実行し、最初の失敗で止める */
function runChecks(workspace: Workspace, config: FactoryConfig, opts: { deadline: number; signal: AbortSignal; now: () => number }): Promise<CheckRun>;

/** 実装役に差し込む文（失敗したコマンド・終了コード・ログ） */
function checkFeedback(run: CheckRun): string;
```

## `src/pipeline/diff.ts`

```ts
interface DiffStat { files: number; insertions: number; deletions: number }
interface DiffSource {
  /** 基準のコミットを覚える（工程の開始時） */
  base(workdir: string): Promise<string>;
  /** 基準からの全変更（追跡していない新しいファイルを含む）。インデックスと作業ツリーは変えない */
  diff(workdir: string, base: string): Promise<{ diff: string; stat: DiffStat }>;
}
const gitDiffSource: DiffSource;
```

## `src/llm/complete.ts`（ツールなしの1回呼び出し）

```ts
interface CompletionMessage { role: "user" | "assistant"; text: string }
interface CompletionResult {
  ok: boolean;
  text: string;
  /** 出力の上限で切れた */
  truncated: boolean;
  usage?: { input: number; output: number };
  error?: string;                         // マスク済み
  budgetExceeded: boolean;
  aborted: boolean;
}

/** 予算ゲートを通し、tools を渡さずに1回呼ぶ。例外を投げない */
function completeOnce(
  gate: GateDeps,
  ctx: CallContext,                       // { jobId, phase: "plan" | "judge", role: "planner" | "verifier" }
  req: { role: ModelRole; systemPrompt: string; messages: CompletionMessage[]; signal?: AbortSignal },
): Promise<CompletionResult>;
```

## `src/harness/structured.ts`

```ts
/** 出力から最初の JSON オブジェクトを取り出す（コードブロックの囲み・前後の説明文を許す） */
function extractJsonObject(text: string): unknown | undefined;
/** スキーマで検証し、合わなければ「パス: 理由」の一覧 */
function validate<T>(schema: TSchema, value: unknown): { ok: true; value: T } | { ok: false; errors: string[] };
/** 再要求の user メッセージ */
function repairMessage(errors: string[]): string;
```

## 004 への追加

```ts
interface ImplementerInput {
  // ...004 のまま
  /**
   * 実装役が完了を告げた（ツールを呼ばず、差し込みもない）ときに呼ぶ。
   * 文字列を返すと差し込んで続ける（ターン数の上限は数え続ける）。undefined なら完了で終わる。
   * 例外は「失敗」として扱う
   */
  onComplete?: (signal: AbortSignal) => Promise<string | undefined>;
}
interface ImplementerResult {
  // ...004 のまま
  completionChecks: number;     // onComplete を呼んだ回数
}

interface Workspace {
  // ...004 のまま
  /** 作業場の中で sh -c を実行する（工程内テスト用。検査・整形は通さない） */
  exec(command: string, opts: { timeoutMs: number; signal?: AbortSignal }):
    Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>;
}
```

## `src/trace/replay.ts` への追加

```ts
/** 1回呼び出し（plan・judge）の run の各呼び出しの入力を復元する */
function replayCompletion(records: readonly TraceRecord[], runId: number):
  { systemPrompt: string; messages: CompletionMessage[] }[];
```
