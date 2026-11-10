import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openTraceWriter, type TraceRecord } from "./writer.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-writer-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readLines(path: string): TraceRecord[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceRecord);
}

const GH_TOKEN = `ghp_${"a".repeat(36)}`;

describe("openTraceWriter", () => {
  test("ジョブごとのファイルに1行ずつ追記し、共通の項目を付ける", () => {
    const traceDir = join(tempDir(), "nested", "traces");
    let now = 1000;
    const writer = openTraceWriter({
      traceDir,
      jobId: 7,
      runId: 3,
      phase: "implement",
      attempt: 2,
      secrets: [],
      now: () => now++,
    });
    expect(writer.path).toBe(join(traceDir, "job-7.jsonl"));
    expect(writer.relativePath).toBe("job-7.jsonl");
    writer.write({ type: "note", message: "a" });
    writer.write({ type: "steer", text: "b", accepted: true });
    expect(readLines(writer.path)).toEqual([
      { ts: 1000, run: 3, phase: "implement", attempt: 2, seq: 0, type: "note", message: "a" },
      {
        ts: 1001,
        run: 3,
        phase: "implement",
        attempt: 2,
        seq: 1,
        type: "steer",
        text: "b",
        accepted: true,
      },
    ]);
  });

  test("同じジョブの別の run は同じファイルに追記される", () => {
    const traceDir = tempDir();
    const open = (runId: number) =>
      openTraceWriter({
        traceDir,
        jobId: 1,
        runId,
        phase: "implement",
        attempt: runId,
        secrets: [],
        now: () => 0,
      });
    open(1).write({ type: "note", message: "first" });
    open(2).write({ type: "note", message: "second" });
    expect(readLines(join(traceDir, "job-1.jsonl")).map((r) => [r.run, r.seq])).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  test("文字列の値（入れ子の中も）の秘密情報と、渡した文字列そのものを伏せる", () => {
    const writer = openTraceWriter({
      traceDir: tempDir(),
      jobId: 1,
      runId: 1,
      phase: "implement",
      attempt: 1,
      secrets: ["sk-test-SECRET", "", undefined],
      now: () => 0,
    });
    writer.write({
      type: "message",
      message: {
        role: "toolResult",
        content: [
          { type: "text", text: `token=${GH_TOKEN}` },
          { type: "text", text: "Authorization: Bearer abc.def" },
          {
            type: "text",
            text: "-----BEGIN RSA PRIVATE KEY-----\nxxx\n-----END RSA PRIVATE KEY-----",
          },
          { type: "text", text: "key is sk-test-SECRET here" },
        ],
      },
    });
    const text = readFileSync(writer.path, "utf8");
    expect(text).not.toContain(GH_TOKEN);
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("xxx");
    expect(text).not.toContain("sk-test-SECRET");
    expect(text).toContain("[REDACTED]");
  });

  test("書けない場所では例外を投げる", () => {
    const traceDir = tempDir();
    // ファイルの場所にディレクトリがあると追記できない
    mkdirSync(join(traceDir, "job-1.jsonl"));
    const writer = openTraceWriter({
      traceDir,
      jobId: 1,
      runId: 1,
      phase: "implement",
      attempt: 1,
      secrets: [],
      now: () => 0,
    });
    expect(() => writer.write({ type: "note", message: "x" })).toThrow();
  });

  test("trace_dir がファイルなら開くときに例外を投げる", () => {
    const file = join(tempDir(), "not-a-dir");
    writeFileSync(file, "");
    expect(() =>
      openTraceWriter({
        traceDir: file,
        jobId: 1,
        runId: 1,
        phase: "implement",
        attempt: 1,
        secrets: [],
        now: () => 0,
      }),
    ).toThrow();
  });
});
