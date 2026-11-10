# Contract: 後続の機能に渡すモジュール

005（生産ライン）・009（CI 連携）・012（回帰評価）が import する関数と型。シグネチャは目安で、名前と役割をこの形で固定する。
`pi-agent-core` を import するのは `src/pipeline/implement.ts` だけ（research R9）。ここに書く型はどれも Pi の型を含まない。

## `src/pipeline/implement.ts`

```ts
type ImplementerOutcome =
  | "completed" | "max_turns" | "timeout" | "budget_exceeded"
  | "blocked_repeatedly" | "aborted" | "failed";

interface Feedback {
  /** 例: "前回の判定の理由" "CI の失敗ログ（test ジョブ）" "前回の diff" */
  title: string;
  body: string;
}

interface ImplementerInput {
  jobId: number;
  workspace: Workspace;            // 下の harness/workspace.ts
  issue: string;                   // Issue のタイトルと本文
  plan: string;                    // 計画役の出力（005）。テストと implement:dev では手書き
  feedback?: Feedback[];           // やり直しのとき（005・009）。毎回新しい会話で始める
  deadline: number;                // UTC の Unix ミリ秒。ジョブ全体の期限から呼び出し側が決める
  maxTurns?: number;               // 既定は [limits].max_turns_per_phase
  signal?: AbortSignal;            // 呼び出し側の中断
}

interface ImplementerDeps {
  gate: GateDeps;                  // 002。models・db・config・logger・apiKey・fetch（テストでは偽の fetch）
  now?: () => number;              // 既定は gate.now ?? Date.now
  /** テスト専用: 実装役のモデルを差し替える（contextWindow を小さくするなど）。既定は modelForRole(gate.models, config, "implementer")。型は src/llm/stream.ts が re-export する pi-ai の Model */
  model?: Model<"openai-completions">;
}

interface ImplementerResult {
  outcome: ImplementerOutcome;
  lastMessage: string;             // 最後の assistant メッセージの本文（なければ空）
  truncatedOutput: boolean;        // 最後の応答が出力の上限で切れた
  turns: number;
  requests: number;                // llm_calls の増分（リトライを含む）
  toolCalls: number;
  blockedCalls: number;
  error?: string;                  // failed・budget_exceeded のとき（マスク済み）
  runId: number;                   // agent_runs.id
  attempt: number;
  tracePath: string;               // 軌跡のファイルの絶対パス
}

interface ImplementerRun {
  /** 実行中ならメッセージを差し込んで true。終わったあとは false（FR-019〜021） */
  steer(text: string): boolean;
  /** 中断する（signal を渡すのと同じ） */
  abort(): void;
  /** 例外で reject しない（FR-003） */
  result: Promise<ImplementerResult>;
}

function startImplementer(deps: ImplementerDeps, input: ImplementerInput): ImplementerRun;
function runImplementer(deps: ImplementerDeps, input: ImplementerInput): Promise<ImplementerResult>;
// = startImplementer(...).result
```

- 工程の名前は `implement`、役割は `implementer`（`llm_calls` と `agent_runs`）
- 作業場の用意と片付け、依存のインストール、diff の取り出しは呼び出し側が行う

## `src/harness/workspace.ts`

作業場（003）を実装役から使う形にまとめる。テストでは偽物（`src/pipeline/testing.ts`）を渡す。

```ts
interface Workspace {
  tools: FactoryTool[];            // 003 の4ツール（Pi の AgentTool と同じ形）
  guard: Guard;                    // 003 の composeGuards の結果
  transform: ResultTransform;      // 003 の composeTransforms の結果
  /** 作業ディレクトリ直下の AGENTS.md。ない・外を指す・読めないなら undefined（FR-014） */
  readAgentsMd(): Promise<string | undefined>;
}

function workspaceFromSandbox(sandbox: Sandbox, config: FactoryConfig): Workspace;
// createTools + パスの検査 + コマンドの検査 + 切り詰めとマスクの整形 をつなぐ
```

## `src/harness/context.ts`

```ts
interface InitialContext {
  systemPrompt: string;
  initialMessage: string;          // AGENTS.md・Issue 文・計画・フィードバックを区切って並べたもの
  truncated: string[];             // 切り詰めた部分の名前（"agents_md" など）
}

function buildInitialContext(input: {
  agentsMd: string | undefined; issue: string; plan: string; feedback: Feedback[];
}, limits: ImplementerConfig): InitialContext;

/** 区切りのタグを、データの中で崩す（R3） */
function escapeDataBlock(text: string, tag: string): string;

/** 構造だけを見るメッセージの型（Pi に依存しない） */
interface ContextMessage {
  role: string;
  toolCallId?: string;
  toolName?: string;
  content: unknown;
}

function estimateTokens(messages: readonly ContextMessage[]): number;   // UTF-8 バイト数 ÷ 3

function compactContext<M extends ContextMessage>(messages: readonly M[], options: {
  contextWindow: number; compactionRatio: number; keepRecentTurns: number;
}): { messages: M[]; compactedToolCallIds: string[]; estimatedTokens: number; estimatedTokensAfter: number };

function compactionNote(message: ContextMessage): string;   // 置き換える注記（復元でも使う）
```

## `src/harness/stop.ts`

```ts
type StopReason = "max_turns" | "timeout" | "blocked_repeatedly" | "sandbox_unavailable";

class StopTracker {
  constructor(limits: { maxTurns: number; deadline: number; maxConsecutiveBlocks: number }, now: () => number);
  onTurnEnd(): void;
  onBlocked(): void;
  onToolResult(details: ToolDetails): void;   // 拒否されなかった呼び出し。sandbox_unavailable を数える
  onDeadlineAbort(): void;
  /** 止めるべきなら理由。finishTurn から呼ぶ */
  check(): StopReason | undefined;
  readonly turns: number;
  readonly reason: StopReason | undefined;
}
```

## `src/trace/`

```ts
// trace/writer.ts
interface TraceWriter {
  write(record: TraceRecordInput): void;     // 同期で1行追記。失敗したら例外
  readonly path: string;
}
function openTraceWriter(options: {
  traceDir: string; jobId: number; runId: number; phase: string; attempt: number;
  secrets: readonly string[];                 // APIキーなど、そのまま伏せ字にする文字列
  now: () => number;
}): TraceWriter;

// trace/runs.ts（agent_runs 表）
function startAgentRun(db: Db, row: { jobId: number; phase: string; model: string; tracePath: string; startedAt: number }): { id: number; attempt: number };
function finishAgentRun(db: Db, id: number, summary: AgentRunSummary): void;

// trace/replay.ts
function readTrace(path: string): TraceRecord[];
/** run の各 LLM 呼び出しの入力（システムの指示 + メッセージ列）を復元する */
function replayRequests(records: readonly TraceRecord[], runId: number): { turn: number; systemPrompt: string; messages: unknown[] }[];
```

## `src/pipeline/testing.ts`（テスト専用）

```ts
/** メモリ上のファイルで動く偽の4ツール。名前・引数のスキーマは 003 と同じ。本物の検査と整形を通す */
function createFakeWorkspace(files: Record<string, string>, options?: { agentsMd?: string; config?: FactoryConfig }): Workspace & { files: Map<string, string>; commands: string[] };

/** 偽の LLM 用の応答の列を作るヘルパー（read → write → bash → 完了 など） */
function toolCallResponse(name: string, args: Record<string, unknown>): FakeResponse;
```
