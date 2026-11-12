/**
 * 工程内テスト（005 US2、research R5）。設定のコマンドを作業場の中で順に実行し、最初の失敗で止める。
 * LLM は使わない。コマンドは対象リポジトリのファイルから読まない（原則 VI）。
 */
import type { FactoryConfig } from "../config.ts";
import { escapeAllDataBlocks } from "../harness/context.ts";
import { truncateMiddle } from "../harness/results.ts";
import type { Workspace } from "../harness/workspace.ts";
import { maskSecrets } from "../trace/mask.ts";

export interface CheckResult {
  command: string;
  /** 打ち切りは 124 など作業場の値 */
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  /** マスク・切り詰め後 */
  output: string;
  /** 切り詰め前の文字数 */
  outputChars: number;
}

export type CheckRun =
  | { kind: "passed" | "failed"; results: CheckResult[] }
  /** check_commands が空 */
  | { kind: "skipped" }
  /** 起動できない（126・127）・作業場の異常。テスト失敗ではなく工程全体の失敗 */
  | { kind: "unavailable"; error: string; results: CheckResult[] };

/** 起動できない終了コード（実行権限がない・コマンドがない） */
const NOT_RUNNABLE = new Set([126, 127]);

export interface RunChecksOptions {
  /** UTC の Unix ミリ秒 */
  deadline: number;
  signal: AbortSignal;
  now: () => number;
  /** そのまま伏せ字にする文字列（APIキーなど） */
  secrets?: readonly string[];
}

function maskAll(text: string, secrets: readonly string[]): string {
  let masked = maskSecrets(text);
  for (const secret of secrets) if (secret !== "") masked = masked.split(secret).join("[REDACTED]");
  return masked;
}

/** 設定のコマンドを順に実行し、最初の失敗で止める。signal の中止で打ち切る */
export async function runChecks(
  workspace: Workspace,
  config: FactoryConfig,
  options: RunChecksOptions,
): Promise<CheckRun> {
  const commands = config.pipeline.check_commands;
  if (commands.length === 0) return { kind: "skipped" };
  const results: CheckResult[] = [];
  for (const command of commands) {
    if (options.signal.aborted) return { kind: "failed", results };
    const remaining = options.deadline - options.now();
    const timeoutMs = Math.max(
      1,
      Math.min(config.pipeline.check_timeout_seconds * 1000, remaining),
    );
    let executed: Awaited<ReturnType<Workspace["exec"]>>;
    try {
      executed = await workspace.exec(command, { timeoutMs, signal: options.signal });
    } catch (error) {
      if (options.signal.aborted) return { kind: "failed", results };
      return {
        kind: "unavailable",
        error: maskAll(
          `作業場でコマンドを実行できません（${command}）: ${error instanceof Error ? error.message : String(error)}`,
          options.secrets ?? [],
        ),
        results,
      };
    }
    const raw = [executed.stdout, executed.stderr].filter((part) => part !== "").join("\n");
    const masked = maskAll(raw, options.secrets ?? []);
    const result: CheckResult = {
      command,
      exitCode: executed.exitCode,
      durationMs: executed.durationMs,
      timedOut: executed.timedOut,
      output: truncateMiddle(masked, config.pipeline.max_check_log_chars).text,
      outputChars: raw.length,
    };
    results.push(result);
    if (!result.timedOut && NOT_RUNNABLE.has(result.exitCode)) {
      return {
        kind: "unavailable",
        error: `テストのコマンドを起動できません（${command}、終了コード ${result.exitCode}）`,
        results,
      };
    }
    if (result.timedOut || result.exitCode !== 0) return { kind: "failed", results };
  }
  return { kind: "passed", results };
}

/** 実装役に差し込む文（失敗したコマンド・終了コード・ログ） */
export function checkFeedback(run: CheckRun): string {
  if (run.kind !== "failed") return "";
  const failed = run.results.at(-1);
  if (!failed) return "工程内テストが打ち切られました。";
  const status = failed.timedOut
    ? "時間の上限を超えたため打ち切りました"
    : `終了コード ${failed.exitCode}`;
  return escapeAllDataBlocks(
    [
      "ファクトリーが工程内テストを実行したところ、失敗しました。原因を直してから、もう一度作業を終えてください。",
      `コマンド: ${failed.command}`,
      `結果: ${status}`,
      "--- 出力 ---",
      failed.output === "" ? "（出力なし）" : failed.output,
    ].join("\n"),
  );
}

/** 判定に渡す、テストの結果の要約 */
export function checksSummary(run: CheckRun | undefined): string {
  if (run === undefined) return "工程内テストは実行していません。";
  if (run.kind === "skipped")
    return "工程内テストのコマンドが設定されていないため、実行していません。";
  const lines = run.results.map(
    (r) =>
      `- ${r.command}: ${r.timedOut ? "時間切れ" : r.exitCode === 0 ? "成功" : `失敗（終了コード ${r.exitCode}）`}（${r.durationMs} ms）`,
  );
  return [`結果: ${run.kind === "passed" ? "すべて成功" : "失敗"}`, ...lines].join("\n");
}
