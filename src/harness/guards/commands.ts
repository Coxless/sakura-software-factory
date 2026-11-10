import type { Guard } from "../compose.ts";

export type CommandRule = { pattern: RegExp; reason: string };

/** コマンドの区切り（行頭・; & | ( ` $( の直後）。この直後に来る語をコマンドとみなす */
const START = String.raw`(?:^|[;&|(\x60\n]|\$\()\s*(?:\w+=\S*\s+)*`;
const cmd = (names: string, rest = "") => new RegExp(`${START}(?:${names})\\b${rest}`, "m");

/**
 * 危険なコマンドの形（research R9）。やわらかい層で、言い換えで迂回できる前提。
 * 本当の防御は作業場の隔離（層5）と出荷前チェック（層6）が行う。
 */
export const DANGEROUS_COMMANDS: readonly CommandRule[] = [
  {
    // rm -rf / ・ rm -r ~ ・ rm -fr .. ・ rm -rf $HOME など
    pattern: new RegExp(
      `${START}rm\\s+(?:-\\S+\\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\\s+(?:-\\S+\\s+)*(?:"|')?(?:/(?:\\*)?|~/?|\\$HOME/?|\\.\\.(?:/\\S*)?|/workspace/?)(?:"|')?(?:\\s|$|;|&|\\|)`,
      "m",
    ),
    reason: "作業ディレクトリの外・ルート・作業ディレクトリ全体の再帰削除",
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/,
    reason: "外部から取得したスクリプトの実行",
  },
  {
    pattern: /\b(?:ba|z|da)?sh\s+<\(\s*(?:curl|wget)\b/,
    reason: "外部から取得したスクリプトの実行",
  },
  {
    pattern: cmd("git", String.raw`(?:\s+-\S+(?:\s+\S+)?)*\s+push\b`),
    reason: "リモートへの push。git push はファクトリーが行います",
  },
  {
    pattern: cmd("git", String.raw`(?:\s+-\S+(?:\s+\S+)?)*\s+remote\s+(?:add|set-url)\b`),
    reason: "リモートの追加・変更",
  },
  { pattern: cmd("sudo|su|doas"), reason: "権限の昇格" },
  { pattern: cmd("docker|podman|nsenter|chroot|unshare"), reason: "コンテナ・名前空間の操作" },
  { pattern: cmd("mkfs(?:\\.\\w+)?|mount|umount"), reason: "ファイルシステムの作成・マウント" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//, reason: "デバイスへの直接書き込み" },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, reason: "フォーク爆弾" },
];

const NAME = "command";

/** bash のコマンドを危険な形の一覧で検査する（層3）。ほかのツールは素通し */
export function createCommandGuard(rules: readonly CommandRule[] = DANGEROUS_COMMANDS): Guard {
  return async (call) => {
    if (call.toolName !== "bash") return undefined;
    const args = call.args;
    if (args === null || typeof args !== "object") return undefined;
    const command = (args as { command?: unknown }).command;
    if (typeof command !== "string") return undefined;
    const hit = rules.find((rule) => rule.pattern.test(command));
    if (!hit) return undefined;
    return {
      block: true,
      guard: NAME,
      reason: `このコマンドは実行できません（理由: ${hit.reason}）。別の方法で進めてください`,
    };
  };
}
