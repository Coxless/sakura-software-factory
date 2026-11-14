/**
 * 自己確認（012 FR-004、research R11）: 各ケースで「何もしなければ合格条件が落ち、模範解答を重ねると工程内テストと合格条件が通る」かを確かめる。
 * LLM・APIキー・DB を使わない。
 */
import type { FactoryConfig } from "../config.ts";
import { runChecks } from "../pipeline/checks.ts";
import type { EvalCase, EvalSet } from "./cases.ts";
import { runGrader, withCheckCommands } from "./grade.ts";
import type { PrepareCase, PreparedCase } from "./prepare.ts";

export interface SelfCheckResult {
  caseId: string;
  ok: boolean;
  problems: string[];
}

export interface SelfCheckOptions {
  now?: () => number;
  signal?: AbortSignal;
  onCase?: (evalCase: EvalCase) => void;
}

/**
 * 自己確認の作業場の ID（コンテナの名前に使う）。ジョブを作らないので、大きな値＋プロセス ID で、
 * 同時に動く別の自己確認やジョブとぶつからないようにする
 */
const SELF_CHECK_JOB_BASE = 900_000_000 + (process.pid % 10_000) * 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 失敗したコマンドの要約（ログの末尾だけ） */
function failedSummary(results: readonly { command: string; exitCode: number; output: string }[]) {
  const failed = results.find((r) => r.exitCode !== 0);
  if (!failed) return "";
  return `（${failed.command} → 終了コード ${failed.exitCode}: ${failed.output.slice(-300).trim()}）`;
}

async function checkOne(
  evalCase: EvalCase,
  index: number,
  config: FactoryConfig,
  prepare: PrepareCase,
  options: Required<Pick<SelfCheckOptions, "now">> & { signal: AbortSignal },
): Promise<SelfCheckResult> {
  const problems: string[] = [];
  const grade = async (prepared: PreparedCase) =>
    runGrader(prepared, evalCase, config, {
      signal: options.signal,
      now: options.now,
      secrets: [],
    });

  // 1. 何もしない状態で合格条件が落ちる
  let prepared: PreparedCase | undefined;
  try {
    prepared = await prepare(evalCase, config, SELF_CHECK_JOB_BASE + index * 2);
    const before = await grade(prepared);
    if (before.status === "passed") {
      problems.push("何もしていないのに合格条件が通ります（Issue を解かなくても成功になる）");
    } else if (before.status === "unavailable") {
      problems.push(`合格条件を実行できません: ${before.error ?? ""}`);
    }
  } catch (error) {
    problems.push(`用意に失敗しました: ${errorText(error)}`);
  } finally {
    await prepared?.close().catch(() => {});
  }

  // 2. 模範解答で工程内テストと合格条件が通る（隠しのファイルが残らないよう新しい複製で）
  prepared = undefined;
  try {
    prepared = await prepare(evalCase, config, SELF_CHECK_JOB_BASE + index * 2 + 1);
    await prepared.applySolution();
    if (evalCase.checkCommands.length > 0) {
      const checks = await runChecks(
        prepared.workspace,
        withCheckCommands(config, evalCase.checkCommands),
        {
          deadline: options.now() + config.pipeline.check_timeout_seconds * 1000 * 2,
          signal: options.signal,
          now: options.now,
        },
      );
      if (checks.kind !== "passed") {
        problems.push(
          `模範解答で工程内テストが通りません${checks.kind === "skipped" ? "" : failedSummary(checks.results)}`,
        );
      }
    }
    const after = await grade(prepared);
    if (after.status !== "passed") {
      problems.push(
        `模範解答で合格条件が通りません${after.error ? `: ${after.error}` : failedSummary(after.results)}`,
      );
    }
  } catch (error) {
    problems.push(`用意に失敗しました: ${errorText(error)}`);
  } finally {
    await prepared?.close().catch(() => {});
  }
  return { caseId: evalCase.id, ok: problems.length === 0, problems };
}

/** セットの全ケースを自己確認する。例外は投げない */
export async function selfCheck(
  set: EvalSet,
  config: FactoryConfig,
  prepare: PrepareCase,
  options: SelfCheckOptions = {},
): Promise<SelfCheckResult[]> {
  const now = options.now ?? Date.now;
  const signal = options.signal ?? new AbortController().signal;
  const results: SelfCheckResult[] = [];
  for (const [index, evalCase] of set.cases.entries()) {
    if (signal.aborted) break;
    options.onCase?.(evalCase);
    results.push(await checkOne(evalCase, index, config, prepare, { now, signal }));
  }
  return results;
}
