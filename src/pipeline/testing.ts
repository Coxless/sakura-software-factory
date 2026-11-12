/**
 * テスト専用: 作業場の代わりにメモリ上のファイルで動く偽の Workspace と、偽の LLM の応答のヘルパー。
 * ツールの名前・説明・引数のスキーマは 003 の本物（createTools）からそのまま取り、検査と整形も本物を通す。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../config.ts";
import {
  composeGuards,
  composeTransforms,
  type ToolErrorKind,
  type ToolResult,
  textResult,
} from "../harness/compose.ts";
import { createCommandGuard } from "../harness/guards/commands.ts";
import { createPathGuard } from "../harness/guards/paths.ts";
import { createTruncateTransform, maskSecretsTransform } from "../harness/results.ts";
import type { Workspace } from "../harness/workspace.ts";
import {
  createTestGateDeps,
  type FakeResponse,
  type FakeToolCall,
  type TestConfigOverrides,
} from "../llm/testing.ts";
import { jobs } from "../queue/schema.ts";
import type { Sandbox } from "../sandbox/docker.ts";
import { resolveWorkspacePath } from "../sandbox/paths.ts";
import { createTools, type FactoryTool } from "../sandbox/tools.ts";
import type { TraceRecord } from "../trace/writer.ts";
import type { DiffSource } from "./diff.ts";

/** 偽の bash の動き。結果を返すか、待つか */
export type FakeBashBehavior =
  | { exitCode?: number; output?: string; error?: ToolErrorKind }
  | { waitMs: number; exitCode?: number; output?: string }
  /** signal が中止されるまで待つ（中止されたら打ち切った結果を返す） */
  | { waitForAbort: true };

export interface FakeWorkspaceOptions {
  agentsMd?: string;
  config: FactoryConfig;
  /** bash の応答。コマンドを受け取って決める。既定は終了コード 0・空の出力 */
  bash?: (command: string) => FakeBashBehavior;
  /** read_file / write_file / edit_file を作業場の異常（sandbox_unavailable）にする */
  sandboxDown?: boolean;
  /**
   * Workspace.exec（005 の工程内テスト）の応答。既定は終了コード 0・空の出力。
   * `error` を指定すると例外（作業場が使えない）を投げる
   */
  exec?: (command: string) => FakeBashBehavior;
}

export interface FakeWorkspace extends Workspace {
  files: Map<string, string>;
  /** bash に渡されたコマンド */
  commands: string[];
  /** ツールの実行の開始と終了の順（"start:read_file" / "end:read_file"） */
  executions: string[];
  /** bash に渡された signal（中止されたかを確かめる） */
  bashSignals: (AbortSignal | undefined)[];
  /** Workspace.exec に渡されたコマンドと時間の上限・signal（005） */
  execs: { command: string; timeoutMs: number; signal: AbortSignal | undefined }[];
}

const unusedSandbox: Sandbox = {
  jobId: 0,
  name: "fake",
  workspace: "/nonexistent",
  exec: () => Promise.reject(new Error("偽の作業場では使わない")),
  realpath: (path) => Promise.resolve(path),
  destroy: () => Promise.resolve(),
};

function fail(tool: string, error: ToolErrorKind, text: string): ToolResult {
  return textResult(text, { tool, error }, true);
}

function relativeOf(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const resolved = resolveWorkspacePath(path);
  return resolved.kind === "inside" ? resolved.relative : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => resolve(true), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}

/** メモリ上のファイルで動く偽の4ツールと、本物の検査・整形 */
export function createFakeWorkspace(
  initialFiles: Record<string, string>,
  options: FakeWorkspaceOptions,
): FakeWorkspace {
  const files = new Map(Object.entries(initialFiles));
  const commands: string[] = [];
  const executions: string[] = [];
  const bashSignals: (AbortSignal | undefined)[] = [];
  const real = new Map(
    createTools(unusedSandbox, options.config.tools).map((tool) => [tool.name, tool]),
  );

  const impl: Record<
    string,
    (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>
  > = {
    read_file: async (params) => {
      if (options.sandboxDown)
        return fail("read_file", "sandbox_unavailable", "作業場が使えません");
      const path = relativeOf(params.path);
      if (path === undefined)
        return fail("read_file", "outside_workspace", "作業ディレクトリの外です");
      const content = files.get(path);
      if (content === undefined)
        return fail("read_file", "not_found", `ファイルがありません: ${path}`);
      const body = content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
        .join("\n");
      return textResult(body, { tool: "read_file", path });
    },
    write_file: async (params) => {
      if (options.sandboxDown)
        return fail("write_file", "sandbox_unavailable", "作業場が使えません");
      const path = relativeOf(params.path);
      if (path === undefined)
        return fail("write_file", "outside_workspace", "作業ディレクトリの外です");
      const existed = files.has(path);
      files.set(path, String(params.content));
      return textResult(`${existed ? "上書き" : "作成"}しました: ${path}`, {
        tool: "write_file",
        path,
      });
    },
    edit_file: async (params) => {
      if (options.sandboxDown)
        return fail("edit_file", "sandbox_unavailable", "作業場が使えません");
      const path = relativeOf(params.path);
      if (path === undefined)
        return fail("edit_file", "outside_workspace", "作業ディレクトリの外です");
      const content = files.get(path);
      if (content === undefined)
        return fail("edit_file", "not_found", `ファイルがありません: ${path}`);
      const from = String(params.old_string);
      const count = content.split(from).length - 1;
      if (count === 0) return fail("edit_file", "no_match", "置換元が見つかりません");
      if (count > 1 && params.replace_all !== true) {
        return fail("edit_file", "multiple_matches", `置換元が ${count} か所あります`);
      }
      files.set(path, content.split(from).join(String(params.new_string)));
      return textResult(`置き換えました: ${path}`, { tool: "edit_file", path });
    },
    bash: async (params, signal) => {
      const command = String(params.command);
      commands.push(command);
      bashSignals.push(signal);
      const behavior = options.bash?.(command) ?? {};
      if ("waitForAbort" in behavior) {
        await sleep(60_000, signal);
        return textResult("打ち切りました", { tool: "bash", error: "timed_out" }, true);
      }
      if ("waitMs" in behavior) {
        const finished = await sleep(behavior.waitMs, signal);
        if (!finished)
          return textResult("打ち切りました", { tool: "bash", error: "timed_out" }, true);
      }
      if ("error" in behavior && behavior.error) {
        return fail("bash", behavior.error, "作業場が使えません");
      }
      const exitCode = behavior.exitCode ?? 0;
      return textResult(`終了コード: ${exitCode}\n${behavior.output ?? ""}`, {
        tool: "bash",
        exitCode,
      });
    },
  };

  const tools: FactoryTool[] = [...real.values()].map((tool) => ({
    ...tool,
    execute: async (_id, params, signal) => {
      executions.push(`start:${tool.name}`);
      const run = impl[tool.name];
      const result = run
        ? await run(params as Record<string, unknown>, signal)
        : fail(tool.name, "invalid_args", "未知のツール");
      executions.push(`end:${tool.name}`);
      return result;
    },
  }));

  const execs: FakeWorkspace["execs"] = [];
  const exec: Workspace["exec"] = async (command, execOptions) => {
    execs.push({ command, timeoutMs: execOptions.timeoutMs, signal: execOptions.signal });
    const behavior = options.exec?.(command) ?? {};
    const started = Date.now();
    const done = (exitCode: number, output: string, timedOut = false) => ({
      exitCode,
      stdout: output,
      stderr: "",
      timedOut,
      durationMs: Date.now() - started,
    });
    if ("waitForAbort" in behavior) {
      await sleep(60_000, execOptions.signal);
      return done(124, "打ち切りました", true);
    }
    if ("waitMs" in behavior) {
      const finished = await sleep(
        Math.min(behavior.waitMs, execOptions.timeoutMs),
        execOptions.signal,
      );
      if (!finished || behavior.waitMs > execOptions.timeoutMs) return done(124, "", true);
    }
    if ("error" in behavior && behavior.error) throw new Error("作業場が使えません");
    return done(behavior.exitCode ?? 0, behavior.output ?? "");
  };

  return {
    files,
    commands,
    executions,
    bashSignals,
    execs,
    exec,
    tools,
    guard: composeGuards(
      {
        name: "path",
        guard: createPathGuard({
          denyWritePaths: options.config.tools.deny_write_paths,
          resolveRealPath: async (path) => path,
        }),
      },
      { name: "command", guard: createCommandGuard() },
    ),
    transform: composeTransforms(
      maskSecretsTransform,
      createTruncateTransform(options.config.tools.max_output_chars),
    ),
    readAgentsMd: async () => options.agentsMd,
  };
}

let callSeq = 0;

/** ツール呼び出し1つの応答（id は重ならないように振る） */
export function toolCallResponse(name: string, args: Record<string, unknown>): FakeResponse {
  callSeq += 1;
  return {
    toolCall: { name, args, id: `call_${callSeq}` },
    usage: { input: 100, output: 20 },
  };
}

/** 1つの応答で複数のツールを呼ぶ */
export function toolCallsResponse(
  calls: { name: string; args: Record<string, unknown> }[],
): FakeResponse {
  return {
    toolCalls: calls.map((call): FakeToolCall => {
      callSeq += 1;
      return { ...call, id: `call_${callSeq}` };
    }),
    usage: { input: 100, output: 20 },
  };
}

/** テキストの応答（完了を告げる） */
export function textResponse(text: string): FakeResponse {
  return { text, usage: { input: 100, output: 20 } };
}

/**
 * テスト専用: 偽の作業場のファイルと初期の内容を比べる偽の DiffSource（005）。
 * 本物の git の形には合わせない（ファイルごとの簡単な unified diff）。
 */
export function createFakeDiffSource(
  workspace: { files: Map<string, string> },
  initialFiles: Record<string, string>,
): DiffSource {
  return {
    base: async () => "fake-base",
    diff: async () => {
      const paths = [...new Set([...Object.keys(initialFiles), ...workspace.files.keys()])].sort();
      const parts: string[] = [];
      let files = 0;
      let insertions = 0;
      let deletions = 0;
      for (const path of paths) {
        const before = initialFiles[path];
        const after = workspace.files.get(path);
        if (before === after) continue;
        files += 1;
        const removed = before === undefined ? [] : before.split("\n");
        const added = after === undefined ? [] : after.split("\n");
        deletions += removed.length;
        insertions += added.length;
        parts.push(
          [
            `diff --git a/${path} b/${path}`,
            `--- ${before === undefined ? "/dev/null" : `a/${path}`}`,
            `+++ ${after === undefined ? "/dev/null" : `b/${path}`}`,
            ...removed.map((line) => `-${line}`),
            ...added.map((line) => `+${line}`),
          ].join("\n"),
        );
      }
      return {
        diff: parts.length === 0 ? "" : `${parts.join("\n")}\n`,
        stat: { files, insertions, deletions },
      };
    },
  };
}

/**
 * テスト専用: 005 の工程のテストの準備（偽の LLM・:memory: の DB・ジョブの行・一時ディレクトリの軌跡）。
 * cleanup() で一時ディレクトリを消す
 */
export function createPipelineTestEnv(
  responses: FakeResponse[],
  config: Omit<TestConfigOverrides, "storage"> = {},
  options: { onHang?: () => void } = {},
) {
  const traceDir = mkdtempSync(join(tmpdir(), "pipeline-test-"));
  const gate = createTestGateDeps({
    responses,
    config: { ...config, storage: { trace_dir: traceDir } },
    onHang: options.onHang ?? (() => {}),
  });
  const [job] = gate.db
    .insert(jobs)
    .values({
      repo: "local:demo",
      issue_number: 0,
      trigger_comment_id: 1,
      requested_by: "dev",
      instruction: "@agent",
      created_at: 1,
      updated_at: 1,
    })
    .returning()
    .all();
  const jobId = job?.id as number;
  const tracePath = join(traceDir, `job-${jobId}.jsonl`);
  const trace = (): TraceRecord[] => {
    let text = "";
    try {
      text = readFileSync(tracePath, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as TraceRecord);
  };
  return {
    gate,
    jobId,
    traceDir,
    tracePath,
    trace,
    /** 偽の LLM が受け取った要求の本文（JSON 文字列。tools の有無や区切りの確認に使う） */
    requestBodies: () => gate.fake.requests.map((request) => JSON.stringify(request.body)),
    cleanup() {
      gate.close();
      rmSync(traceDir, { recursive: true, force: true });
    },
  };
}
