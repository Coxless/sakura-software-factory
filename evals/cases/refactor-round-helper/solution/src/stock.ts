import { roundTo } from "./math.ts";

export interface StockItem {
  name: string;
  quantity: number;
  /** 1個あたりの円 */
  unitPrice: number;
}

/** 在庫の金額の合計（小数第2位まで） */
export function totalValue(items: readonly StockItem[]): number {
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  return roundTo(total, 2);
}

/** 1品目あたりの平均の数量（小数第2位まで）。品目がなければ 0 */
export function averageQuantity(items: readonly StockItem[]): number {
  if (items.length === 0) return 0;
  const average = items.reduce((sum, item) => sum + item.quantity, 0) / items.length;
  return roundTo(average, 2);
}
