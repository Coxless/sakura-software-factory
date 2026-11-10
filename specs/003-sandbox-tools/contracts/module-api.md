# Contract: 004 以降に渡すモジュール

シグネチャは目安で、名前と役割をこの形で固定する。

## `src/sandbox/docker.ts`

```ts
type SandboxOptions = {
  jobId: number;
  workspace: string;                 // ホストの絶対パス
  sandbox: FactoryConfig["sandbox"];
};

type ExecOptions = { input?: string | Uint8Array; timeoutSeconds?: number; signal?: AbortSignal };

interface Sandbox {
  readonly jobId: number;
  readonly name: string;             // factory-job-<jobId>
  readonly workspace: string;
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>; // docker exec。作業場がなければ SandboxError
  realpath(path: string): Promise<string>;  // 作業場の中で realpath -m（/workspace 基準）
  destroy(): Promise<void>;          // docker rm -f。何度呼んでもよい
}

class SandboxError extends Error { readonly kind: "docker_unavailable" | "image_missing" | "start_failed" | "unavailable" | "invalid_user" }

function createSandbox(options: SandboxOptions): Promise<Sandbox>;         // 同名の残骸があれば片付けてから作る。失敗時は途中のものを残さない
function withSandbox<T>(options: SandboxOptions, fn: (sandbox: Sandbox) => Promise<T>): Promise<T>; // finally で destroy
function removeStaleSandboxes(): Promise<number>;                          // ラベル sakura-factory.sandbox=1 を全部片付け、数を返す（007 の起動時に呼ぶ）

function installDependencies(options: SandboxOptions & {
  command: readonly string[];        // 例 ["pnpm", "install", "--frozen-lockfile"]
}): Promise<ExecResult>;             // ネットワークありの一時コンテナ。上限は sandbox.install_timeout_seconds。終わったら残さない
```

## `src/sandbox/tools.ts`

```ts
type TextContent = { type: "text"; text: string };
type ToolResult<D = ToolDetails> = { content: TextContent[]; details: D; isError: boolean };

interface FactoryTool<P extends TSchema = TSchema> {   // Pi の AgentTool と同じ形
  name: string;
  label: string;
  description: string;
  parameters: P;                    // TypeBox
  executionMode: "sequential";
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

function createTools(sandbox: Sandbox, tools: FactoryConfig["tools"]): FactoryTool[]; // read_file, write_file, edit_file, bash の順
```

`execute` は引数を自分でも TypeBox で検証する（Pi が検証済みでも、単体で使えるように）。

## `src/harness/compose.ts`

```ts
type ToolCall = { toolName: string; args: unknown };
type GuardDecision = { block: true; reason: string; guard: string };
type Guard = (call: ToolCall, signal?: AbortSignal) => Promise<GuardDecision | undefined>;
type ResultTransform = (call: ToolCall, result: ToolResult) => Promise<ToolResult>;

function composeGuards(...guards: Guard[]): Guard;                      // 順に実行。最初の拒否を返し、残りは呼ばない
function composeTransforms(...transforms: ResultTransform[]): ResultTransform; // 順に適用
```

004 での接続の目安:

```ts
beforeToolCall: async ({ toolCall, args }, signal) => {
  const d = await guard({ toolName: toolCall.name, args }, signal);
  return d && { block: true, reason: d.reason };
},
afterToolCall: async ({ toolCall, args, result, isError }) => {
  const r = await transform({ toolName: toolCall.name, args }, { ...result, isError });
  return { content: r.content, details: r.details, isError: r.isError };
},
```

## `src/harness/guards/paths.ts`

```ts
function createPathGuard(options: {
  denyWritePaths: readonly string[];
  resolveRealPath: (path: string) => Promise<string>;   // 通常は sandbox.realpath。テストでは偽物
}): Guard;   // read_file / write_file / edit_file だけを見る。bash は素通し
```

## `src/harness/guards/commands.ts`

```ts
const DANGEROUS_COMMANDS: readonly { pattern: RegExp; reason: string }[];
function createCommandGuard(rules?: readonly { pattern: RegExp; reason: string }[]): Guard; // bash だけを見る
```

## `src/harness/results.ts`

```ts
function truncateMiddle(text: string, maxChars: number): { text: string; trimmedChars: number };
function createTruncateTransform(maxChars: number): ResultTransform;
const maskSecretsTransform: ResultTransform;   // 001 の maskSecrets を content の文字列にかける
```

## `src/harness/index` は作らない

004 で、上の部品を組み合わせて Pi の Agent に渡す（`createPathGuard` → `createCommandGuard` の順に合成、整形は `maskSecretsTransform` → 切り詰めの順）。
