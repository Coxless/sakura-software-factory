import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuantity } from "../src/quantity.ts";

test("前後の空白を許す", () => {
  assert.equal(parseQuantity(" 3 "), 3);
  assert.equal(parseQuantity("\t12\n"), 12);
});

test("先頭の 0 は10進数として読む", () => {
  assert.equal(parseQuantity("007"), 7);
});

test("整数でないものは RangeError", () => {
  for (const text of ["2.5", "1e3", "", " ", "-1", "0", "abc", "3個"]) {
    assert.throws(() => parseQuantity(text), RangeError, `"${text}" が通りました`);
  }
});

test("ふつうの整数", () => {
  assert.equal(parseQuantity("1"), 1);
  assert.equal(parseQuantity("250"), 250);
});
