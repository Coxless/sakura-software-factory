import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const index = readFileSync(join(root, "src/index.ts"), "utf8");

/** src/index.ts の export { a, b, type C } から、型以外の名前 */
function exportedFunctions(): string[] {
  const names: string[] = [];
  for (const match of index.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim();
      if (name !== "" && !name.startsWith("type ")) names.push(name);
    }
  }
  return names;
}

function apiSection(): string | undefined {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^##\s+API\s*$/.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

test("## API の節がある", () => {
  assert.ok(apiSection() !== undefined, "README.md に ## API の見出しがありません");
});

test("公開しているすべての関数が節の中にある", () => {
  const section = apiSection() ?? "";
  const names = exportedFunctions();
  assert.ok(names.length >= 4, `src/index.ts の export が想定より少ない: ${names.join(", ")}`);
  for (const name of names) {
    assert.ok(section.includes(name), `${name} の説明が ## API の節にありません`);
  }
});

test("使用例のコードブロックと例外の説明がある", () => {
  const section = apiSection() ?? "";
  assert.ok(/```/.test(section), "使用例のコードブロックがありません");
  assert.ok(section.includes("RangeError"), "例外（RangeError）の説明がありません");
});
