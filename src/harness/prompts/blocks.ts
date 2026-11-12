/**
 * 計画役・検査役の入力の、データの区切り（005 research R10）。
 * 上限で切り詰め、区切りの閉じタグを崩してから囲む。切り詰めたら truncated="true" を付ける。
 */
import { escapeAllDataBlocks } from "../context.ts";
import { truncateMiddle } from "../results.ts";

export interface DataBlock {
  text: string;
  truncated: boolean;
}

/** `<tag>…</tag>` を作る。max を省くと切り詰めない */
export function dataBlock(tag: string, body: string, max?: number): DataBlock {
  const out = max === undefined ? { text: body, trimmedChars: 0 } : truncateMiddle(body, max);
  const truncated = out.trimmedChars > 0;
  const attr = truncated ? ' truncated="true"' : "";
  return { text: `<${tag}${attr}>\n${escapeAllDataBlocks(out.text)}\n</${tag}>`, truncated };
}

/** ブロックを並べ、切り詰めた名前を集める */
export function joinBlocks(
  intro: string,
  blocks: readonly (readonly [name: string, block: DataBlock])[],
): { text: string; truncated: string[] } {
  return {
    text: [intro, ...blocks.map(([, block]) => block.text)].join("\n\n"),
    truncated: blocks.filter(([, block]) => block.truncated).map(([name]) => name),
  };
}
