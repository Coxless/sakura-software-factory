import { matchDenied, resolveWorkspacePath, toRelative } from "../../sandbox/paths.ts";
import type { Guard, GuardDecision, ToolCall } from "../compose.ts";

const READ_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const NAME = "path";

const DENY_HINT =
  "CI の定義・環境変数ファイル・ロックファイル・デプロイ設定・.git は変更できません";

function block(reason: string): GuardDecision {
  return { block: true, guard: NAME, reason };
}

function pathArg(call: ToolCall): string | undefined {
  const args = call.args;
  if (args === null || typeof args !== "object") return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

/**
 * 読み書きのツールのパスを検査する（層3）。
 * 1. 名前の上で作業ディレクトリの外を拒否
 * 2. 書き込みは禁止パスを拒否
 * 3. 作業場の中で解決した実際のパス（シンボリックリンクを辿った先）でも 1・2 を確かめる
 * bash と、path の形が違う呼び出しは素通しする（後者はツール側の引数の検証で弾く）。
 */
export function createPathGuard(options: {
  denyWritePaths: readonly string[];
  resolveRealPath: (path: string) => Promise<string>;
}): Guard {
  const { denyWritePaths, resolveRealPath } = options;
  return async (call) => {
    const isWrite = WRITE_TOOLS.has(call.toolName);
    if (!isWrite && !READ_TOOLS.has(call.toolName)) return undefined;
    const path = pathArg(call);
    if (path === undefined) return undefined;

    const lexical = resolveWorkspacePath(path);
    if (lexical.kind === "outside") {
      return block(
        `作業ディレクトリの外は扱えません: ${path}（作業ディレクトリからの相対パスで指定してください）`,
      );
    }
    if (lexical.kind === "root") return undefined; // ツール側で「ディレクトリです」と返す

    if (isWrite) {
      const rule = matchDenied(lexical.relative, denyWritePaths);
      if (rule) {
        return block(
          `${lexical.relative} は書き換えが禁止されています（一致した規則: ${rule}）。${DENY_HINT}`,
        );
      }
    }

    const real = await resolveRealPath(lexical.absolute);
    const realRelative = toRelative(real);
    if (realRelative === undefined) {
      return block(
        `${lexical.relative} の実際のパスは ${real} で、作業ディレクトリの外です（シンボリックリンクを辿った先は扱えません）`,
      );
    }
    if (isWrite && realRelative !== lexical.relative) {
      const rule = matchDenied(realRelative, denyWritePaths);
      if (rule) {
        return block(
          `${lexical.relative} の実際のパスは ${realRelative} で、書き換えが禁止されています（一致した規則: ${rule}）。${DENY_HINT}`,
        );
      }
    }
    return undefined;
  };
}
