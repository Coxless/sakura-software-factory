/**
 * 実装役のコンテキスト（004 research R3・R4）: 最初の user メッセージの組み立て、区切りの崩し、入力の見積もり、圧縮。
 * Pi の型を import しない（SC-010）。圧縮はメッセージの構造だけを見る。
 */

import { IMPLEMENTER_SYSTEM_PROMPT } from "./prompts/implementer.ts";
import { truncateMiddle } from "./results.ts";

/** 追加のフィードバック（やり直しのとき。005・009） */
export interface Feedback {
  title: string;
  body: string;
}

export interface ContextLimits {
  max_agents_md_chars: number;
  max_issue_chars: number;
  max_plan_chars: number;
  max_feedback_chars: number;
}

export interface InitialContext {
  systemPrompt: string;
  initialMessage: string;
  /** 切り詰めた部分の名前 */
  truncated: string[];
}

/** データを入れる区切りのタグ */
export const DATA_TAGS = [
  "agents_md",
  "issue",
  "plan",
  "feedback",
  // 005: 計画役・検査役の入力
  "instruction",
  "files",
  "diff",
  "checks",
  // 009: CI のログ
  "ci_log",
] as const;

export const NO_AGENTS_MD =
  "（AGENTS.md はありません。テストの実行方法は package.json などから判断してください）";

/** データの中の、tag の閉じタグ（大文字・空白入りも）を崩す。区切りの外に出られないようにする */
export function escapeDataBlock(text: string, tag: string): string {
  const pattern = new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
  return text.replace(pattern, `<\\/${tag}>`);
}

/** すべての区切りのタグの閉じタグを崩す */
export function escapeAllDataBlocks(text: string): string {
  return DATA_TAGS.reduce((acc, tag) => escapeDataBlock(acc, tag), text);
}

function limit(text: string, max: number, name: string, truncated: string[]): string {
  const out = truncateMiddle(text, max);
  if (out.trimmedChars > 0) truncated.push(name);
  return out.text;
}

function escapeAttribute(text: string): string {
  return text
    .replace(/[\n\r]/g, " ")
    .replace(/"/g, "'")
    .replace(/[<>]/g, "");
}

/** 差し込み（steering）のメッセージの本文 */
export function steeringMessage(text: string): string {
  return `<feedback source="steering">\n${escapeAllDataBlocks(text)}\n</feedback>`;
}

/** 最初の user メッセージを組み立てる。各部分は上限で切り詰め、区切りの閉じタグを崩す */
export function buildInitialContext(
  input: {
    agentsMd: string | undefined;
    issue: string;
    plan: string;
    feedback: readonly Feedback[];
  },
  limits: ContextLimits,
): InitialContext {
  const truncated: string[] = [];
  const agentsMd =
    input.agentsMd === undefined
      ? NO_AGENTS_MD
      : limit(input.agentsMd, limits.max_agents_md_chars, "agents_md", truncated);
  const issue = limit(input.issue, limits.max_issue_chars, "issue", truncated);
  const plan = limit(input.plan, limits.max_plan_chars, "plan", truncated);
  const perFeedback =
    input.feedback.length === 0 ? 0 : Math.floor(limits.max_feedback_chars / input.feedback.length);
  let feedbackTruncated = false;
  const feedback = input.feedback.map((item) => {
    const out = truncateMiddle(item.body, perFeedback);
    if (out.trimmedChars > 0) feedbackTruncated = true;
    return `<feedback title="${escapeAttribute(item.title)}">\n${escapeAllDataBlocks(out.text)}\n</feedback>`;
  });
  if (feedbackTruncated) truncated.push("feedback");

  const parts = [
    "次の Issue を、計画に従って実装してください。",
    `<agents_md>\n${escapeAllDataBlocks(agentsMd)}\n</agents_md>`,
    `<issue>\n${escapeAllDataBlocks(issue)}\n</issue>`,
    `<plan>\n${escapeAllDataBlocks(plan)}\n</plan>`,
    ...feedback,
  ];
  return { systemPrompt: IMPLEMENTER_SYSTEM_PROMPT, initialMessage: parts.join("\n\n"), truncated };
}

/** 構造だけを見るメッセージの型（Pi に依存しない） */
export interface ContextMessage {
  role: string;
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** 入力の大きさの見積もり。UTF-8 のバイト数 ÷ 3（切り上げ）。日本語でもコードでも多めに出る */
export function estimateTokens(messages: readonly unknown[]): number {
  return Math.ceil(bytes(messages) / 3);
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce(
    (sum: number, part) =>
      sum +
      (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text.length
        : 0),
    0,
  );
}

/** 古いツールの結果を置き換える注記（軌跡からの復元でも同じ関数を使う） */
export function compactionNote(message: ContextMessage): string {
  const chars = textLength(message.content).toLocaleString("en-US");
  return `（古いツールの結果を省略しました: ${message.toolName ?? "tool"}、${chars} 文字。必要ならもう一度ツールで取得してください）`;
}

/** toolResult の中身を注記に置き換えたコピー */
export function compactMessage<M extends ContextMessage>(message: M): M {
  return { ...message, content: [{ type: "text", text: compactionNote(message) }] };
}

export interface CompactionOptions {
  contextWindow: number;
  compactionRatio: number;
  keepRecentTurns: number;
}

export interface CompactionResult<M> {
  messages: M[];
  compactedToolCallIds: string[];
  estimatedTokens: number;
  estimatedTokensAfter: number;
}

/**
 * 見積もりが contextWindow × compactionRatio を超えたら、直近 keepRecentTurns ターン（assistant のメッセージで数える）
 * より前のツールの結果を、古い順に注記に置き換える。閾値以下になったらやめる。
 * 入力の配列とメッセージは変えない。同じ入力からは同じ結果になる。
 */
export function compactContext<M extends ContextMessage>(
  messages: readonly M[],
  options: CompactionOptions,
): CompactionResult<M> {
  const estimatedTokens = estimateTokens(messages);
  const threshold = Math.floor(options.contextWindow * options.compactionRatio);
  const result = [...messages];
  const compactedToolCallIds: string[] = [];
  if (estimatedTokens <= threshold) {
    return {
      messages: result,
      compactedToolCallIds,
      estimatedTokens,
      estimatedTokensAfter: estimatedTokens,
    };
  }

  // 直近 keepRecentTurns 個の assistant のうち最も古いものの位置。そこから後ろは残す
  let boundary = result.length;
  let seen = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i]?.role === "assistant") {
      seen += 1;
      boundary = i;
      if (seen >= options.keepRecentTurns) break;
    }
  }
  if (seen < options.keepRecentTurns) boundary = 0;

  let totalBytes = bytes(messages);
  for (let i = 0; i < boundary; i++) {
    if (Math.ceil(totalBytes / 3) <= threshold) break;
    const message = result[i];
    if (message === undefined || message.role !== "toolResult") continue;
    const replaced = compactMessage(message);
    const saved = bytes(message) - bytes(replaced);
    if (saved <= 0) continue;
    result[i] = replaced;
    totalBytes -= saved;
    if (message.toolCallId !== undefined) compactedToolCallIds.push(message.toolCallId);
  }
  return {
    messages: result,
    compactedToolCallIds,
    estimatedTokens,
    estimatedTokensAfter: Math.ceil(totalBytes / 3),
  };
}

/** 軌跡からの復元用: 指定の toolCallId の toolResult を注記に置き換える */
export function applyCompaction<M extends ContextMessage>(
  messages: readonly M[],
  toolCallIds: readonly string[],
): M[] {
  const ids = new Set(toolCallIds);
  return messages.map((message) =>
    message.role === "toolResult" && message.toolCallId !== undefined && ids.has(message.toolCallId)
      ? compactMessage(message)
      : message,
  );
}
