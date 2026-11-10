import { describe, expect, test } from "vitest";
import { compactionNote } from "../harness/context.ts";
import { replayRequests } from "./replay.ts";
import type { TraceRecord } from "./writer.ts";

const common = (run: number, seq: number) => ({
  ts: 0,
  run,
  phase: "implement",
  attempt: run,
  seq,
});

const toolResult = (id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read_file",
  content: [{ type: "text", text }],
});

const records: TraceRecord[] = [
  {
    ...common(1, 0),
    type: "run_start",
    model: "m",
    systemPrompt: "SYS1",
    initialMessage: "FIRST1",
    limits: {
      maxTurns: 10,
      deadline: 0,
      maxConsecutiveBlocks: 5,
      compactionRatio: 0.7,
      keepRecentTurns: 4,
      contextWindow: 1000,
    },
    truncated: [],
  },
  { ...common(2, 0), type: "note", message: "別の run" },
  {
    ...common(1, 1),
    type: "request",
    turn: 1,
    estimatedTokens: 1,
    compactedToolCallIds: [],
    estimatedTokensAfter: 1,
  },
  { ...common(1, 2), type: "message", message: { role: "assistant", content: [] } },
  { ...common(1, 3), type: "message", message: toolResult("c1", "AAAA") },
  { ...common(1, 4), type: "message", message: { role: "user", content: "steer" } },
  {
    ...common(1, 5),
    type: "request",
    turn: 2,
    estimatedTokens: 1,
    compactedToolCallIds: [],
    estimatedTokensAfter: 1,
  },
  { ...common(1, 6), type: "message", message: { role: "assistant", content: [] } },
  { ...common(1, 7), type: "message", message: toolResult("c2", "BBBB") },
  {
    ...common(1, 8),
    type: "request",
    turn: 3,
    estimatedTokens: 9,
    compactedToolCallIds: ["c1"],
    estimatedTokensAfter: 5,
  },
] as TraceRecord[];

describe("replayRequests", () => {
  test("指定の run の各ターンの入力を、圧縮を当て直して復元する", () => {
    const out = replayRequests(records, 1);
    expect(out.map((r) => r.turn)).toEqual([1, 2, 3]);
    expect(out[0]).toEqual({
      turn: 1,
      systemPrompt: "SYS1",
      messages: [{ role: "user", content: "FIRST1" }],
    });
    expect(out[1]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    const third = out[2]?.messages ?? [];
    expect(third).toHaveLength(6);
    expect(third[2]?.content).toEqual([
      { type: "text", text: compactionNote(toolResult("c1", "AAAA")) },
    ]);
    expect(third[5]?.content).toEqual([{ type: "text", text: "BBBB" }]);
  });

  test("run_start がなければ例外", () => {
    expect(() => replayRequests(records, 2)).toThrow(/run_start/);
  });
});
