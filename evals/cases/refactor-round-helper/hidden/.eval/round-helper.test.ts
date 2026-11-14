import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { roundTo } from "../src/math.ts";
import { averageQuantity, totalValue } from "../src/stock.ts";

const root = join(import.meta.dirname, "..");

test("roundTo は小数第 digits 位までに四捨五入する", () => {
  assert.equal(roundTo(3.14159, 2), 3.14);
  assert.equal(roundTo(2.5, 0), 3);
  assert.equal(roundTo(1234.5678, 1), 1234.6);
  assert.equal(roundTo(7, 2), 7);
});

test("stock.ts の重複した丸めがなくなり、roundTo を使っている", () => {
  const source = readFileSync(join(root, "src/stock.ts"), "utf8");
  assert.ok(!source.includes("Math.round("), "src/stock.ts に Math.round( が残っています");
  assert.ok(source.includes("roundTo"), "src/stock.ts が roundTo を使っていません");
});

test("totalValue・averageQuantity の挙動は変わらない", () => {
  const items = [
    { name: "ねじ", quantity: 3, unitPrice: 10.5 },
    { name: "ナット", quantity: 4, unitPrice: 2.25 },
    { name: "ワッシャー", quantity: 1, unitPrice: 0.333 },
  ];
  assert.equal(totalValue(items), 40.83);
  assert.equal(averageQuantity(items), 2.67);
  assert.equal(averageQuantity([]), 0);
});
