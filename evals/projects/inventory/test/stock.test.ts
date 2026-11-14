import assert from "node:assert/strict";
import { test } from "node:test";
import { averageQuantity, totalValue } from "../src/stock.ts";

const items = [
  { name: "ねじ", quantity: 3, unitPrice: 10.5 },
  { name: "ナット", quantity: 4, unitPrice: 2.25 },
];

test("在庫の金額の合計", () => {
  assert.equal(totalValue(items), 40.5);
});

test("平均の数量", () => {
  assert.equal(averageQuantity(items), 3.5);
  assert.equal(averageQuantity([]), 0);
});
