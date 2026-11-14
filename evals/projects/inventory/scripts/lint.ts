/**
 * 簡易の lint。src/ の .ts を読み、決まりに反する行を「ファイル:行: 内容（直し方）」で表示する。見つかれば終了コード 1
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const RULES = [
  {
    pattern: /\bconsole\.log\(/,
    message: "console.log は使わない（ライブラリのコードは出力しない。値は戻り値で返す）",
  },
  {
    pattern: /:\s*any\b/,
    message: "any は使わない（具体的な型か unknown にする）",
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const root = join(import.meta.dirname, "..");
const problems: string[] = [];
for (const file of walk(join(root, "src"))) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        problems.push(`${relative(root, file)}:${index + 1}: ${line.trim()}（${rule.message}）`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`lint: ${problems.length} 件`);
  process.exit(1);
}
console.log("lint: 問題なし");
