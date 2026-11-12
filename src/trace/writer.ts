/**
 * 軌跡の JSONL への追記（004 research R8、data-model.md 2章）。
 * 1ジョブ1ファイル（job-<jobId>.jsonl）。やり直しの回も同じファイルに追記し、各行の run・attempt で区別する。
 * 文字列の値はすべて書く前にマスクする（constitution 原則 V）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { maskSecrets, REDACTED } from "./mask.ts";

/** 軌跡の行の種類ごとの中身 */
export type TraceRecordBody =
  | {
      type: "run_start";
      model: string;
      systemPrompt: string;
      initialMessage: string;
      limits: {
        maxTurns: number;
        deadline: number;
        maxConsecutiveBlocks: number;
        compactionRatio: number;
        keepRecentTurns: number;
        contextWindow: number;
      };
      /** 切り詰めた部分の名前（"agents_md" など） */
      truncated: string[];
    }
  | {
      type: "request";
      /** 1 始まり */
      turn: number;
      estimatedTokens: number;
      /** この呼び出しで注記に置き換えたツールの結果 */
      compactedToolCallIds: string[];
      estimatedTokensAfter: number;
    }
  | { type: "message"; message: unknown }
  | { type: "tool_blocked"; toolCallId: string; toolName: string; guard: string; reason: string }
  | {
      type: "tool_result_meta";
      toolCallId: string;
      toolName: string;
      /** 整形（層4）の前の文字数 */
      originalChars: number;
      details: unknown;
    }
  | { type: "steer"; text: string; accepted: boolean }
  | {
      type: "run_end";
      outcome: string;
      turns: number;
      requests: number;
      toolCalls: number;
      blockedCalls: number;
      compactions: number;
      steers: number;
      lastMessage: string;
      truncatedOutput: boolean;
      error?: string;
      /** 判定の合否（005） */
      verdict?: string;
    }
  | { type: "note"; message: string }
  // 005: ツールなしの1回呼び出し（run は agent_runs.id、phase は plan / judge）
  | {
      type: "llm_request";
      model: string;
      systemPrompt: string;
      /** この呼び出しで増えたメッセージ（1回目は user 1件、再要求では前回の出力と再要求の文） */
      messages: { role: "user" | "assistant"; text: string }[];
      /** 切り詰めた部分の名前 */
      truncated: string[];
    }
  | { type: "validation"; ok: boolean; extracted: boolean; errors: string[] }
  // 005: 工程全体（run = 0、phase = "pipeline"）
  | {
      type: "pipeline_start";
      deadline: number;
      judgeRetries: number;
      checkCommands: string[];
      maxCheckFeedbacks: number;
      planGiven: boolean;
      baseCommit: string;
    }
  | { type: "phase"; name: string; round: number }
  | {
      type: "check_run";
      round: number;
      index: number;
      results: {
        command: string;
        exitCode: number;
        durationMs: number;
        timedOut: boolean;
        outputChars: number;
        output: string;
      }[];
      passed: boolean;
      fedBack: boolean;
    }
  | {
      type: "round_end";
      round: number;
      implementOutcome: string;
      checks: string;
      diffStat: { files: number; insertions: number; deletions: number };
      verdict: string;
      reason?: string;
      next: "retry" | "finish";
    }
  | { type: "pipeline_end"; outcome: string; rounds: number; requests: number; error?: string };

export type TraceRecordType = TraceRecordBody["type"];

/** ファイルの1行 */
export type TraceRecord = TraceRecordBody & {
  ts: number;
  run: number;
  phase: string;
  attempt: number;
  seq: number;
};

export interface TraceWriter {
  /** 1行を同期で追記する。書けなければ例外 */
  write(record: TraceRecordBody): void;
  /** 絶対パス */
  readonly path: string;
  /** storage.trace_dir からの相対パス（agent_runs.trace_path） */
  readonly relativePath: string;
}

export interface TraceWriterOptions {
  traceDir: string;
  jobId: number;
  runId: number;
  phase: string;
  attempt: number;
  /** そのまま伏せ字にする文字列（APIキーなど）。空文字は無視する */
  secrets: readonly (string | undefined)[];
  now: () => number;
}

/** ジョブの軌跡のファイル名（trace_dir からの相対パス） */
export function traceFileName(jobId: number): string {
  return `job-${jobId}.jsonl`;
}

/** 文字列の値すべてに秘密情報のマスクをかける（入れ子の中も） */
export function maskDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let masked = maskSecrets(value);
    for (const secret of secrets) masked = masked.split(secret).join(REDACTED);
    return masked;
  }
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskDeep(item, secrets)]),
    );
  }
  return value;
}

/** 軌跡のファイルを開く（ディレクトリがなければ作る）。書けない場所なら例外 */
export function openTraceWriter(options: TraceWriterOptions): TraceWriter {
  const relativePath = traceFileName(options.jobId);
  const path = join(options.traceDir, relativePath);
  mkdirSync(options.traceDir, { recursive: true });
  const secrets = options.secrets.filter((s): s is string => typeof s === "string" && s !== "");
  let seq = 0;
  return {
    path,
    relativePath,
    write(record) {
      const line: TraceRecord = {
        ts: options.now(),
        run: options.runId,
        phase: options.phase,
        attempt: options.attempt,
        seq,
        ...record,
      } as TraceRecord;
      appendFileSync(path, `${JSON.stringify(maskDeep(line, secrets))}\n`, "utf8");
      seq += 1;
    },
  };
}
