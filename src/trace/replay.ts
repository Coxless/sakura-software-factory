/**
 * 軌跡の読み込みと、各 LLM 呼び出しの入力の復元（004 data-model.md 2章、constitution 原則 V）。
 * run_start の最初の user メッセージに、それまでの message を順に足し、request の一覧に従って圧縮を当て直す。
 */
import { readFileSync } from "node:fs";
import { applyCompaction, type ContextMessage } from "../harness/context.ts";
import type { TraceRecord } from "./writer.ts";

export interface ReplayedRequest {
  /** 1 始まり */
  turn: number;
  systemPrompt: string;
  /** その呼び出しで LLM に渡したメッセージ（システムの指示を除く。マスク後） */
  messages: ContextMessage[];
}

export function readTrace(path: string): TraceRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceRecord);
}

/** run の各 LLM 呼び出しの入力を復元する */
export function replayRequests(records: readonly TraceRecord[], runId: number): ReplayedRequest[] {
  const own = records.filter((r) => r.run === runId).sort((a, b) => a.seq - b.seq);
  const start = own.find((r) => r.type === "run_start");
  if (start?.type !== "run_start") {
    throw new Error(`run ${runId} の run_start がありません`);
  }
  const messages: ContextMessage[] = [
    { role: "user", content: start.initialMessage } as ContextMessage,
  ];
  const requests: ReplayedRequest[] = [];
  for (const record of own) {
    if (record.type === "message") {
      const message = record.message as ContextMessage;
      if (message.role !== "system") messages.push(message);
    } else if (record.type === "request") {
      requests.push({
        turn: record.turn,
        systemPrompt: start.systemPrompt,
        messages: applyCompaction(messages, record.compactedToolCallIds),
      });
    }
  }
  return requests;
}
