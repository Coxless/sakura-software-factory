/**
 * 隠しチェック（012 FR-011、research R1・R3）: 隠しのファイルを作業ディレクトリに上書きで置き、合格条件のコマンドを作業場で順に実行する。
 * 実行は 005 の runChecks をそのまま使う（設定のコピーでコマンドと時間の上限を差し替える）。LLM は使わない。
 */
import type { FactoryConfig } from "../config.ts";
import { type CheckResult, runChecks } from "../pipeline/checks.ts";
import type { EvalCase } from "./cases.ts";
import type { PreparedCase } from "./prepare.ts";

export interface GraderRun {
  status: "passed" | "failed" | "unavailable";
  results: CheckResult[];
  /** unavailable の原因 */
  error?: string;
}

export interface GraderOptions {
  signal: AbortSignal;
  now: () => number;
  secrets: readonly string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 設定のコピーで工程内テストのコマンドを差し替える */
export function withCheckCommands(
  config: FactoryConfig,
  commands: readonly string[],
  timeoutSeconds?: number,
): FactoryConfig {
  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      check_commands: [...commands],
      ...(timeoutSeconds === undefined ? {} : { check_timeout_seconds: timeoutSeconds }),
    },
  } as FactoryConfig;
}

/** 隠しのファイルを置いて合格条件を実行する。例外は投げない */
export async function runGrader(
  prepared: PreparedCase,
  evalCase: EvalCase,
  config: FactoryConfig,
  options: GraderOptions,
): Promise<GraderRun> {
  try {
    await prepared.placeHidden();
  } catch (error) {
    return {
      status: "unavailable",
      results: [],
      error: `隠しのファイルを置けません: ${errorText(error)}`,
    };
  }
  const graderConfig = withCheckCommands(
    config,
    evalCase.grader.commands,
    evalCase.grader.timeoutSeconds,
  );
  const timeoutMs = evalCase.grader.timeoutSeconds * 1000;
  try {
    const run = await runChecks(prepared.workspace, graderConfig, {
      // 期限は合格条件のコマンドの数だけの時間の上限（ジョブの期限とは別）
      deadline: options.now() + timeoutMs * evalCase.grader.commands.length + 1000,
      signal: options.signal,
      now: options.now,
      secrets: options.secrets,
    });
    if (run.kind === "passed") return { status: "passed", results: run.results };
    if (run.kind === "failed") return { status: "failed", results: run.results };
    if (run.kind === "unavailable") {
      return { status: "unavailable", results: run.results, error: run.error };
    }
    return { status: "unavailable", results: [], error: "合格条件のコマンドがありません" };
  } catch (error) {
    return {
      status: "unavailable",
      results: [],
      error: `合格条件を実行できません: ${errorText(error)}`,
    };
  }
}
