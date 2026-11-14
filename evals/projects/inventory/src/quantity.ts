/**
 * 入力された数量の文字列を数にする。前後の空白は許す。1 以上の整数（10進数）だけを受け付け、それ以外は RangeError
 */
export function parseQuantity(text: string): number {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) throw new RangeError(`数量は1以上の整数で入力してください: ${text}`);
  const value = Number.parseInt(trimmed, 10);
  if (value < 1) throw new RangeError(`数量は1以上の整数で入力してください: ${text}`);
  return value;
}
