# Contract: モジュールの入口（`src/evals/` と 005 への変更）

## 005 への変更

### `src/pipeline/run.ts`

```ts
export interface PipelineResult {
  // …既存…
  /** 最後に検査役へ渡した入力（判定まで進まなければ undefined）。diff はマスクしない */
  lastJudge?: { round: number; diff: string; checks: string };
}
```

### `src/pipeline/verify.ts`

```ts
export interface JudgeOptions { alt?: boolean }
/** alt: true なら [models].verifier_alt で、工程名 judge_alt として呼ぶ（012）。役割は verifier のまま */
export function judge(deps: OneShotDeps, input: JudgeInput, options?: JudgeOptions): Promise<OneShotOutcome<Verdict>>;
```

### `src/pipeline/oneshot.ts`

```ts
export interface OneShotRequest<S> {
  phase: "plan" | "judge" | "judge_alt";
  role: "planner" | "verifier";          // llm_calls.role
  /** モデルを引く役割（既定は role）。比較用の検査役は "verifier_alt" */
  modelRole?: ModelRole;
  // …既存…
}
```

## `src/evals/cases.ts`

```ts
export interface EvalCase { id; workType; title; body; instruction?; projectDir; install?; checkCommands: string[];
  grader: { commands: string[]; timeoutSeconds: number }; setupDir?; hiddenDir?; solutionDir; hash: string }
export interface EvalSet { name: string; dir: string; cases: EvalCase[] }
export class EvalSetError extends Error { issues: { caseId: string; message: string }[] }
export function loadEvalSet(dir: string, options?: { only?: string[] }): EvalSet;   // 誤りは EvalSetError
```

## `src/evals/prepare.ts`

```ts
export interface PreparedCase {
  workspace: Workspace; workdir: string;
  diff?: DiffSource; listFiles?: (workdir: string) => Promise<string[]>;
  /** hidden/ を作業ディレクトリに上書きで置く */
  placeHidden(): Promise<void>;
  /** solution/ を重ねる（自己確認用） */
  applySolution(): Promise<void>;
  close(): Promise<void>;   // 作業場を片付け、一時ディレクトリを消す
}
export type PrepareCase = (c: EvalCase, config: FactoryConfig, jobId: number) => Promise<PreparedCase>;
export const prepareCase: PrepareCase;   // 複製 → setup → git init・初期コミット → install → 作業場
```

## `src/evals/grade.ts`

```ts
export type GraderRun = { status: "passed" | "failed" | "unavailable"; results: CheckResult[]; error?: string };
export function runGrader(prepared: PreparedCase, c: EvalCase, config: FactoryConfig,
  options: { signal: AbortSignal; now: () => number; secrets: readonly string[] }): Promise<GraderRun>;
```

`placeHidden` のあと、`grader.commands` を `runChecks`（005）で実行する（設定のコピーで check_commands と check_timeout_seconds を差し替え）。

## `src/evals/runner.ts`

```ts
export interface EvalRunnerDeps { gate: GateDeps; prepare: PrepareCase; now?: () => number;
  harness: () => Promise<{ commit: string; dirty: boolean }> }
export interface EvalRunInput { set: EvalSet; repeat: number; maxRequests: number; timeoutMinutes: number;
  options: { cases: string[] | null }; signal?: AbortSignal;
  onProgress?: (event: EvalProgress) => void }
export function runEvals(deps: EvalRunnerDeps, input: EvalRunInput): Promise<EvalRun>;   // 例外を投げない
```

## `src/evals/result.ts`・`compare.ts`・`format.ts`・`selfcheck.ts`

```ts
export const EvalRunSchema: TSchema;                       // 結果のファイルの形
export function summarize(cases: CaseResult[], models): Summary;
export function writeEvalRun(dir: string, run: EvalRun): string;      // 書いたパス
export function readEvalRun(path: string): EvalRun;                   // 形が合わなければ例外
export function findBaseline(dir: string, setName: string, before: string): { path: string; run: EvalRun } | undefined;
export function compareRuns(baseline: EvalRun, current: EvalRun): Comparison;
export function formatRun(run: EvalRun, comparison?: Comparison): string;
export function formatComparison(c: Comparison): string;
export function selfCheck(set: EvalSet, config: FactoryConfig, prepare: PrepareCase): Promise<SelfCheckResult[]>;
```
