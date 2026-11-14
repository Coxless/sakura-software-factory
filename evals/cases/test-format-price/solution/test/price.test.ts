import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice } from "../src/price.ts";

test("3桁ごとのカンマ区切りと円", () => {
  assert.equal(formatPrice(1234567), "1,234,567円");
  assert.equal(formatPrice(0), "0円");
});

test("負の値は先頭に -", () => {
  assert.equal(formatPrice(-1500), "-1,500円");
});

test("小数は四捨五入", () => {
  assert.equal(formatPrice(99.5), "100円");
  assert.equal(formatPrice(99.4), "99円");
});

test("数でない値は RangeError", () => {
  assert.throws(() => formatPrice(Number.NaN), RangeError);
  assert.throws(() => formatPrice(Number.POSITIVE_INFINITY), RangeError);
});
