import { posix } from "node:path";

/** 作業場の中での作業ディレクトリ */
export const WORKSPACE = "/workspace";

export type WorkspacePath =
  | { kind: "inside"; absolute: string; relative: string }
  | { kind: "root" }
  | { kind: "outside"; absolute: string };

/**
 * ツールの引数のパスを、名前の上で作業ディレクトリ基準に正規化する（シンボリックリンクは見ない）。
 * 相対パスは /workspace 基準、絶対パスはそのまま解釈する。
 */
export function resolveWorkspacePath(path: string): WorkspacePath {
  const absolute = posix.resolve(WORKSPACE, path);
  if (absolute === WORKSPACE) return { kind: "root" };
  if (!absolute.startsWith(`${WORKSPACE}/`)) return { kind: "outside", absolute };
  return { kind: "inside", absolute, relative: absolute.slice(WORKSPACE.length + 1) };
}

/** 作業場の中の絶対パスを、作業ディレクトリからの相対パスにする。外側なら undefined */
export function toRelative(absolute: string): string | undefined {
  const resolved = resolveWorkspacePath(absolute);
  return resolved.kind === "inside" ? resolved.relative : undefined;
}

/** 相対パスが glob の一覧のどれかに一致すれば、その規則を返す */
export function matchDenied(relative: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => posix.matchesGlob(relative, pattern));
}
