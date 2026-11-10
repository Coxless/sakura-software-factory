import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import type { FactoryConfig } from "../config.ts";
import {
  type ToolDetails,
  type ToolErrorKind,
  type ToolResult,
  textResult,
} from "../harness/compose.ts";
import { decode, type Sandbox, SandboxError } from "./docker.ts";
import { resolveWorkspacePath } from "./paths.ts";

export type ToolsConfig = FactoryConfig["tools"];

/** Pi の AgentTool と同じ形（004 でそのまま渡す） */
export interface FactoryTool<P extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: P;
  executionMode: "sequential";
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

/** read_file が一度に読み込むバイト数の上限 */
const READ_MAX_BYTES = 4 * 1024 * 1024;
/** read_file が1行で返す文字数の上限 */
const READ_MAX_LINE_CHARS = 2000;
/** バイナリかどうかを見る先頭のバイト数 */
const BINARY_SNIFF_BYTES = 8192;
/** 作業場の中の timeout が効かなかったときの、ホスト側の猶予 */
const HOST_GRACE_SECONDS = 15;

/**
 * パスを作業場の中で解決し、/workspace の下でなければ終了コード 5。
 * $1 に対象のパス、$R に解決したパスが入る。
 */
const RESOLVE = `R=$(realpath -m -- "$1") || exit 6; case "$R" in /workspace/*) ;; *) exit 5;; esac`;

const READ_SCRIPT = `${RESOLVE}
[ -e "$R" ] || exit 3
[ -d "$R" ] && exit 4
stat -c %s -- "$R" >&2
head -c "$2" -- "$R"`;

const WRITE_SCRIPT = `${RESOLVE}
[ -d "$R" ] && exit 4
if [ -e "$R" ]; then echo existed; else echo created; fi
mkdir -p -- "$(dirname -- "$R")" && cat > "$R"`;

export const ReadParams = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "読むファイル（作業ディレクトリからの相対パス）",
    }),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: "開始行（1 始まり。既定 1）" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "読む行数" })),
  },
  { additionalProperties: false },
);

export const WriteParams = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "書くファイル（作業ディレクトリからの相対パス）",
    }),
    content: Type.String({ description: "ファイル全体の内容" }),
  },
  { additionalProperties: false },
);

export const EditParams = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "編集するファイル（作業ディレクトリからの相対パス）",
    }),
    old_string: Type.String({
      minLength: 1,
      description: "置換元。ファイルの中で一意になるよう前後の行も含める",
    }),
    new_string: Type.String({ description: "置換先" }),
    replace_all: Type.Optional(
      Type.Boolean({ description: "true ならすべての出現を置き換える（既定 false）" }),
    ),
  },
  { additionalProperties: false },
);

export const BashParams = Type.Object(
  {
    command: Type.String({ minLength: 1, description: "bash -c で実行するコマンド" }),
    timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, description: "時間の上限（秒）" })),
  },
  { additionalProperties: false },
);

function fail(
  tool: string,
  error: ToolErrorKind,
  text: string,
  extra: Partial<ToolDetails> = {},
): ToolResult {
  return textResult(text, { tool, error, ...extra }, true);
}

function validate<P extends TSchema>(
  tool: string,
  schema: P,
  params: unknown,
): Static<P> | ToolResult {
  if (Value.Check(schema, params)) return params as Static<P>;
  const issues = [...Value.Errors(schema, params)].map(
    (e) =>
      `${(e as { instancePath: string }).instancePath || "/"}: ${(e as { message: string }).message}`,
  );
  return fail(tool, "invalid_args", `引数が正しくありません: ${issues.join("; ")}`);
}

const isResult = (value: unknown): value is ToolResult =>
  value !== null && typeof value === "object" && "content" in value && "isError" in value;

/** 名前の上で作業ディレクトリの中のパスにする。外側・作業ディレクトリそのものはエラーの結果 */
function checkPath(
  tool: string,
  path: string,
): { absolute: string; relative: string } | ToolResult {
  const resolved = resolveWorkspacePath(path);
  if (resolved.kind === "outside") {
    return fail(
      tool,
      "outside_workspace",
      `作業ディレクトリの外は扱えません: ${path}（作業ディレクトリからの相対パスで指定してください）`,
    );
  }
  if (resolved.kind === "root") {
    return fail(
      tool,
      "is_directory",
      `ディレクトリです: ${path}。ファイルのパスを指定してください（中身は bash の ls で確かめられます）`,
    );
  }
  return resolved;
}

/** スクリプトの終了コードのうち、共通のもの（3〜6）をエラーの結果にする */
function scriptError(
  tool: string,
  exitCode: number,
  relative: string,
  stderr: Uint8Array,
): ToolResult | undefined {
  switch (exitCode) {
    case 3:
      return fail(tool, "not_found", `ファイルがありません: ${relative}`);
    case 4:
      return fail(
        tool,
        "is_directory",
        `ディレクトリです: ${relative}。ファイルのパスを指定してください（中身は bash の ls で確かめられます）`,
      );
    case 5:
      return fail(
        tool,
        "outside_workspace",
        `${relative} の実際のパスは作業ディレクトリの外です（シンボリックリンクを辿った先は扱えません）`,
      );
    case 6:
      return fail(
        tool,
        "sandbox_unavailable",
        `パスを解決できません: ${relative}: ${decode(stderr).trim()}`,
      );
    default:
      return undefined;
  }
}

/** 作業場の異常（SandboxError）をエラーの結果にする。それ以外の例外は投げ直す */
async function guarded(
  tool: string,
  started: number,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = await fn();
  } catch (error) {
    if (!(error instanceof SandboxError)) throw error;
    result = fail(tool, "sandbox_unavailable", `作業場が使えません: ${error.message}`);
  }
  return {
    ...result,
    details: { ...result.details, durationMs: Math.round(performance.now() - started) },
  };
}

async function readRaw(sandbox: Sandbox, absolute: string, maxBytes: number, signal?: AbortSignal) {
  const result = await sandbox.exec(["sh", "-c", READ_SCRIPT, "sh", absolute, String(maxBytes)], {
    signal,
  });
  return result;
}

function hasNul(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function readFileTool(sandbox: Sandbox, config: ToolsConfig): FactoryTool<typeof ReadParams> {
  const name = "read_file";
  return {
    name,
    label: "ファイルを読む",
    description: `作業ディレクトリのファイルを行番号付きで読む。1回で最大 ${config.read_max_lines} 行。offset と limit で範囲を指定できる`,
    parameters: ReadParams,
    executionMode: "sequential",
    execute: (_id, params, signal) =>
      guarded(name, performance.now(), async () => {
        const args = validate(name, ReadParams, params);
        if (isResult(args)) return args;
        const path = checkPath(name, args.path);
        if (isResult(path)) return path;
        const raw = await readRaw(sandbox, path.absolute, READ_MAX_BYTES, signal);
        const error = scriptError(name, raw.exitCode, path.relative, raw.stderr);
        if (error) return error;
        if (raw.exitCode !== 0) {
          return fail(
            name,
            "sandbox_unavailable",
            `読めません: ${path.relative}: ${decode(raw.stderr).trim()}`,
          );
        }
        const size = Number.parseInt(decode(raw.stderr), 10) || raw.stdout.length;
        if (hasNul(raw.stdout)) {
          return textResult(`バイナリファイルです（${size} バイト）。内容は返しません`, {
            tool: name,
            path: path.relative,
            binary: true,
          });
        }
        if (raw.stdout.length === 0) {
          return textResult("（空のファイルです）", {
            tool: name,
            path: path.relative,
            totalLines: 0,
          });
        }
        const text = decode(raw.stdout);
        const lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        const bytesTruncated = size > raw.stdout.length;
        const totalLines = lines.length;
        const offset = args.offset ?? 1;
        const limit = Math.min(args.limit ?? config.read_max_lines, config.read_max_lines);
        if (offset > totalLines) {
          return fail(
            name,
            "invalid_args",
            `offset（${offset}）がファイルの行数（${totalLines}${bytesTruncated ? " 以上" : ""}）を超えています`,
          );
        }
        const end = Math.min(offset - 1 + limit, totalLines);
        const body = lines
          .slice(offset - 1, end)
          .map((line, i) => {
            const shown =
              line.length > READ_MAX_LINE_CHARS
                ? `${line.slice(0, READ_MAX_LINE_CHARS)}…（行を切り詰めました）`
                : line;
            return `${String(offset + i).padStart(6)}\t${shown}`;
          })
          .join("\n");
        const more = end < totalLines || bytesTruncated;
        const note = more
          ? `\n（${totalLines}${bytesTruncated ? " 行以上" : "行"}中 ${offset}〜${end}行目。続きは offset: ${end + 1} で読めます）`
          : "";
        return textResult(body + note, {
          tool: name,
          path: path.relative,
          startLine: offset,
          endLine: end,
          totalLines,
          binary: false,
          truncated: more,
        });
      }),
  };
}

async function writeContent(
  sandbox: Sandbox,
  absolute: string,
  content: string,
  signal?: AbortSignal,
) {
  return sandbox.exec(["sh", "-c", WRITE_SCRIPT, "sh", absolute], { input: content, signal });
}

function writeFileTool(sandbox: Sandbox): FactoryTool<typeof WriteParams> {
  const name = "write_file";
  return {
    name,
    label: "ファイルを書く",
    description:
      "作業ディレクトリのファイルを丸ごと書く（なければ作る。途中のディレクトリも作る）。一部だけ変えるときは edit_file を使う",
    parameters: WriteParams,
    executionMode: "sequential",
    execute: (_id, params, signal) =>
      guarded(name, performance.now(), async () => {
        const args = validate(name, WriteParams, params);
        if (isResult(args)) return args;
        const path = checkPath(name, args.path);
        if (isResult(path)) return path;
        const result = await writeContent(sandbox, path.absolute, args.content, signal);
        const error = scriptError(name, result.exitCode, path.relative, result.stderr);
        if (error) return error;
        if (result.exitCode !== 0) {
          return fail(
            name,
            "sandbox_unavailable",
            `書けません: ${path.relative}: ${decode(result.stderr).trim()}`,
          );
        }
        const created = decode(result.stdout).trim() === "created";
        const bytes = new TextEncoder().encode(args.content).length;
        return textResult(
          `${path.relative} に書き込みました（${created ? "新規" : "上書き"}、${bytes} バイト）`,
          {
            tool: name,
            path: path.relative,
            bytes,
            created,
          },
        );
      }),
  };
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  for (let i = text.indexOf(search); i !== -1; i = text.indexOf(search, i + search.length)) count++;
  return count;
}

function editFileTool(sandbox: Sandbox): FactoryTool<typeof EditParams> {
  const name = "edit_file";
  return {
    name,
    label: "ファイルを部分的に置き換える",
    description:
      "作業ディレクトリのファイルの old_string を new_string に置き換える。old_string はちょうど1回現れる必要がある（replace_all: true ならすべて）。事前に read_file で内容を確かめる",
    parameters: EditParams,
    executionMode: "sequential",
    execute: (_id, params, signal) =>
      guarded(name, performance.now(), async () => {
        const args = validate(name, EditParams, params);
        if (isResult(args)) return args;
        const path = checkPath(name, args.path);
        if (isResult(path)) return path;
        if (args.old_string === args.new_string) {
          return fail(name, "no_change", "old_string と new_string が同じです");
        }
        const raw = await readRaw(sandbox, path.absolute, READ_MAX_BYTES + 1, signal);
        const error = scriptError(name, raw.exitCode, path.relative, raw.stderr);
        if (error) return error;
        if (raw.exitCode !== 0) {
          return fail(
            name,
            "sandbox_unavailable",
            `読めません: ${path.relative}: ${decode(raw.stderr).trim()}`,
          );
        }
        if (raw.stdout.length > READ_MAX_BYTES) {
          return fail(
            name,
            "invalid_args",
            `${path.relative} は大きすぎるため編集できません（${READ_MAX_BYTES} バイトまで）`,
          );
        }
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(raw.stdout);
        } catch {
          return fail(
            name,
            "invalid_args",
            `${path.relative} は UTF-8 のテキストではないため編集できません`,
          );
        }
        let oldString = args.old_string;
        let newString = args.new_string;
        if (text.includes("\r\n") && !oldString.includes("\r")) {
          oldString = oldString.replaceAll("\n", "\r\n");
          newString = newString.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
        }
        const count = countOccurrences(text, oldString);
        if (count === 0) {
          return fail(
            name,
            "no_match",
            `old_string が ${path.relative} に見つかりません。read_file で現在の内容を確かめてください`,
          );
        }
        if (count > 1 && !args.replace_all) {
          return fail(
            name,
            "multiple_matches",
            `old_string が ${path.relative} に ${count} か所あります。前後の行を含めて一意にするか、replace_all: true を指定してください`,
          );
        }
        const updated = args.replace_all
          ? text.replaceAll(oldString, () => newString)
          : text.replace(oldString, () => newString);
        const written = await writeContent(sandbox, path.absolute, updated, signal);
        const writeError = scriptError(name, written.exitCode, path.relative, written.stderr);
        if (writeError) return writeError;
        if (written.exitCode !== 0) {
          return fail(
            name,
            "sandbox_unavailable",
            `書けません: ${path.relative}: ${decode(written.stderr).trim()}`,
          );
        }
        const replacements = args.replace_all ? count : 1;
        return textResult(`${path.relative} を編集しました（${replacements}か所）`, {
          tool: name,
          path: path.relative,
          replacements,
        });
      }),
  };
}

function section(label: string, bytes: Uint8Array): string {
  const text = decode(bytes);
  return `--- ${label} ---\n${text.length > 0 ? text.replace(/\n$/, "") : "（なし）"}`;
}

function bashTool(sandbox: Sandbox, config: ToolsConfig): FactoryTool<typeof BashParams> {
  const name = "bash";
  return {
    name,
    label: "コマンドを実行する",
    description: `作業ディレクトリで bash のコマンドを実行し、終了コードと標準出力・標準エラーを返す。ネットワークはない（依存は準備工程でインストール済み）。時間の上限は既定 ${config.bash_timeout_seconds} 秒、timeout_seconds で最大 ${config.bash_max_timeout_seconds} 秒まで。ファイルの読み書きには read_file / write_file / edit_file を使う`,
    parameters: BashParams,
    executionMode: "sequential",
    execute: (_id, params, signal) =>
      guarded(name, performance.now(), async () => {
        const args = validate(name, BashParams, params);
        if (isResult(args)) return args;
        const timeoutSeconds = Math.min(
          args.timeout_seconds ?? config.bash_timeout_seconds,
          config.bash_max_timeout_seconds,
        );
        const result = await sandbox.exec(
          ["timeout", "--kill-after=5", String(timeoutSeconds), "bash", "-c", args.command],
          { timeoutSeconds: timeoutSeconds + HOST_GRACE_SECONDS, signal },
        );
        const timedOut =
          result.timedOut ||
          result.exitCode === 124 ||
          (result.exitCode === 137 && result.durationMs >= timeoutSeconds * 1000);
        const head = timedOut
          ? `時間の上限（${timeoutSeconds}秒）を超えたため打ち切りました。\n`
          : "";
        const overflow = result.truncated
          ? "\n（出力が大きすぎるため、途中で取り込みを打ち切りました）"
          : "";
        const text = `${head}exit_code: ${result.exitCode}\n${section("stdout", result.stdout)}\n${section("stderr", result.stderr)}${overflow}`;
        return textResult(
          text,
          {
            tool: name,
            exitCode: result.exitCode,
            timedOut,
            timeoutSeconds,
            stdoutBytes: result.stdout.length,
            stderrBytes: result.stderr.length,
            outputTruncated: result.truncated,
            ...(timedOut ? { error: "timed_out" as const } : {}),
          },
          timedOut,
        );
      }),
  };
}

/** 作業場の上で動く4ツール（read_file, write_file, edit_file, bash の順） */
export function createTools(sandbox: Sandbox, config: ToolsConfig): FactoryTool[] {
  return [
    readFileTool(sandbox, config),
    writeFileTool(sandbox),
    editFileTool(sandbox),
    bashTool(sandbox, config),
  ] as FactoryTool[];
}
