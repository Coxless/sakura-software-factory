import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuantity } from "../src/quantity.ts";

test("整数の文字列を数にする", () => {
  assert.equal(parseQuantity("3"), 3);
});

test("数でない文字列は RangeError", () => {
  assert.throws(() => parseQuantity("abc"), RangeError);
});

test("前後の空白を許す", () => {
  assert.equal(parseQuantity(" 3 "), 3);
});

test("小数は RangeError", () => {
  assert.throws(() => parseQuantity("2.5"), RangeError);
});
