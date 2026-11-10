/**
 * 作業場（003）を実装役から使う形にまとめる: 4ツール・検査（層3）・整形（層4）・AGENTS.md の読み込み。
 * Pi に依存しない（004 research R9）。テストでは src/pipeline/testing.ts の偽物を渡す。
 */
import type { FactoryConfig } from "../config.ts";
import { decode, type Sandbox } from "../sandbox/docker.ts";
import { WORKSPACE } from "../sandbox/paths.ts";
import { createTools, type FactoryTool } from "../sandbox/tools.ts";
import { composeGuards, composeTransforms, type Guard, type ResultTransform } from "./compose.ts";
import { createCommandGuard } from "./guards/commands.ts";
import { createPathGuard } from "./guards/paths.ts";
import { createTruncateTransform, maskSecretsTransform } from "./results.ts";

export interface Workspace {
  /** 003 の4ツール（Pi の AgentTool と同じ形） */
  tools: FactoryTool[];
  /** 実行前の検査（層3）の合成 */
  guard: Guard;
  /** 実行後の整形（層4）の合成 */
  transform: ResultTransform;
  /** 作業ディレクトリ直下の AGENTS.md。ない・外を指す・読めないなら undefined（FR-014） */
  readAgentsMd(): Promise<string | undefined>;
}

/** AGENTS.md を読むときのバイト数の上限（入力に入れるときは [implementer].max_agents_md_chars で切る） */
const AGENTS_MD_MAX_BYTES = 1024 * 1024;

/** read_file と同じく、作業場の中で実際のパスに解決してから /workspace の下のファイルだけを読む */
const READ_AGENTS_MD = `R=$(realpath -m -- "$1") || exit 6
case "$R" in ${WORKSPACE}/*) ;; *) exit 5;; esac
[ -f "$R" ] || exit 3
head -c "$2" -- "$R"`;

/** 作業場の上で、ツール・検査・整形・AGENTS.md の読み込みをつなぐ */
export function workspaceFromSandbox(sandbox: Sandbox, config: FactoryConfig): Workspace {
  return {
    tools: createTools(sandbox, config.tools),
    guard: composeGuards(
      {
        name: "path",
        guard: createPathGuard({
          denyWritePaths: config.tools.deny_write_paths,
          resolveRealPath: (path) => sandbox.realpath(path),
        }),
      },
      { name: "command", guard: createCommandGuard() },
    ),
    // 先にマスクしてから切り詰める（切り詰めで秘密情報の一部だけが残らないように）
    transform: composeTransforms(
      maskSecretsTransform,
      createTruncateTransform(config.tools.max_output_chars),
    ),
    async readAgentsMd() {
      try {
        const result = await sandbox.exec([
          "sh",
          "-c",
          READ_AGENTS_MD,
          "sh",
          `${WORKSPACE}/AGENTS.md`,
          String(AGENTS_MD_MAX_BYTES),
        ]);
        if (result.exitCode !== 0) return undefined;
        return decode(result.stdout);
      } catch {
        return undefined;
      }
    },
  };
}
