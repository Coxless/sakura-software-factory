import assert from "node:assert/strict";
import { test } from "node:test";
import { averageQuantity, totalValue } from "../src/stock.ts";

const items = [
  { name: "ねじ", quantity: 3, unitPrice: 10.5 },
  { name: "ナット", quantity: 4, unitPrice: 2.25 },
  { name: "ワッシャー", quantity: 1, unitPrice: 0.333 },
];

test("合計は小数第2位まで", () => {
  assert.equal(totalValue(items), 40.83);
  assert.equal(totalValue([]), 0);
});

test("平均の数量は小数第2位まで", () => {
  assert.equal(averageQuantity(items), 2.67);
  assert.equal(averageQuantity([]), 0);
});
