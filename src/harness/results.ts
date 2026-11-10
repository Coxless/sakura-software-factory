import { maskSecrets } from "../trace/mask.ts";
import type { ResultTransform, ToolResult } from "./compose.ts";

const HEAD_RATIO = 0.3;

/**
 * 長い文字列の間を省き、先頭 30%・末尾 70% を残す（テストの失敗やエラーは末尾に出やすいため）。
 * 結果の長さは maxChars ＋ 省略の注記（1行）以内に収まる。
 */
export function truncateMiddle(
  text: string,
  maxChars: number,
): { text: string; trimmedChars: number } {
  if (text.length <= maxChars) return { text, trimmedChars: 0 };
  const head = Math.floor(maxChars * HEAD_RATIO);
  const tail = maxChars - head;
  const trimmedChars = text.length - head - tail;
  const note = `\n…（長いため ${trimmedChars} 文字を省きました。必要なら範囲を絞って読み直してください）…\n`;
  return { text: text.slice(0, head) + note + text.slice(text.length - tail), trimmedChars };
}

function mapText(result: ToolResult, fn: (text: string) => string): ToolResult {
  return { ...result, content: result.content.map((part) => ({ ...part, text: fn(part.text) })) };
}

/** 結果の文字列を maxChars で切り詰める（層4） */
export function createTruncateTransform(maxChars: number): ResultTransform {
  return async (_call, result) => {
    let trimmed = 0;
    const next = mapText(result, (text) => {
      const out = truncateMiddle(text, maxChars);
      trimmed += out.trimmedChars;
      return out.text;
    });
    if (trimmed === 0) return result;
    return { ...next, details: { ...result.details, trimmedChars: trimmed } };
  };
}

/** 結果の文字列の秘密情報らしい部分を伏せる（層4）。ログと同じ判定（trace/mask.ts） */
export const maskSecretsTransform: ResultTransform = async (_call, result) => {
  let masked = false;
  const next = mapText(result, (text) => {
    const out = maskSecrets(text);
    if (out !== text) masked = true;
    return out;
  });
  if (!masked) return result;
  return { ...next, details: { ...result.details, masked: true } };
};
