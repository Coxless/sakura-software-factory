/**
 * 入力された数量の文字列を数にする。前後の空白は許す。1 以上の整数（10進数）だけを受け付け、それ以外は RangeError
 */
export function parseQuantity(text: string): number {
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new RangeError(`数量は1以上の整数で入力してください: ${text}`);
  }
  const value = Number.parseFloat(text);
  if (value < 1) throw new RangeError(`数量は1以上の整数で入力してください: ${text}`);
  return value;
}
