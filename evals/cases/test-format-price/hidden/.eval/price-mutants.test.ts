/**
 * 隠しチェック: formatPrice を壊した版に差し替えた複製で、エージェントの test/price.test.ts が落ちることを確かめる。
 * 作業ディレクトリは変えない（/tmp に複製する）
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

const MUTANTS: Record<string, string> = {
  カンマ区切りなし: `export function formatPrice(yen: number): string {
  if (!Number.isFinite(yen)) throw new RangeError("x");
  const rounded = Math.round(Math.abs(yen));
  return \`\${yen < 0 && rounded !== 0 ? "-" : ""}\${rounded}円\`;
}
`,
  負の符号なし: `export function formatPrice(yen: number): string {
  if (!Number.isFinite(yen)) throw new RangeError("x");
  const rounded = Math.round(Math.abs(yen));
  return \`\${String(rounded).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",")}円\`;
}
`,
  切り捨て: `export function formatPrice(yen: number): string {
  if (!Number.isFinite(yen)) throw new RangeError("x");
  const rounded = Math.floor(Math.abs(yen));
  const digits = String(rounded).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  return \`\${yen < 0 && rounded !== 0 ? "-" : ""}\${digits}円\`;
}
`,
  例外なし: `export function formatPrice(yen: number): string {
  const rounded = Math.round(Math.abs(yen));
  const digits = String(rounded).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");
  return \`\${yen < 0 && rounded !== 0 ? "-" : ""}\${digits}円\`;
}
`,
};

test("test/price.test.ts がある", () => {
  assert.ok(existsSync(join(root, "test/price.test.ts")), "test/price.test.ts がありません");
});

for (const [name, source] of Object.entries(MUTANTS)) {
  test(`壊した版（${name}）でエージェントのテストが落ちる`, () => {
    const dir = mkdtempSync(join(tmpdir(), "mutant-"));
    try {
      cpSync(root, dir, {
        recursive: true,
        filter: (src) => !src.includes(`${root}/.git`) && !src.includes("node_modules"),
      });
      writeFileSync(join(dir, "src/price.ts"), source);
      // 親のテストランナーの NODE_TEST_CONTEXT を引き継ぐと、子の失敗が終了コードに出ないので外す
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      const run = spawnSync(process.execPath, ["--test", "test/price.test.ts"], {
        cwd: dir,
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.notEqual(run.status, 0, `壊した版（${name}）でもテストが通りました`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
