/**
 * pnpm run eval:compare: 2つの評価の結果のファイルを比べて表示する（012 contracts/commands.md）。LLM・DB・設定を使わない。
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { compareRuns } from "./evals/compare.ts";
import { formatComparison } from "./evals/format.ts";
import { readEvalRun } from "./evals/result.ts";

export const EXIT_OK = 0;
export const EXIT_ERROR = 2;

export function runEvalCompareCli(
  argv: string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): number {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let positionals: string[];
  let json: boolean;
  try {
    const parsed = parseArgs({
      args,
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
    positionals = parsed.positionals;
    json = parsed.values.json === true;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
  if (positionals.length !== 2) {
    io.stderr("使い方: pnpm run eval:compare -- <baseline.json> <current.json> [--json]\n");
    return EXIT_ERROR;
  }
  const [baselinePath, currentPath] = positionals as [string, string];
  try {
    const comparison = compareRuns(readEvalRun(baselinePath), readEvalRun(currentPath));
    io.stdout(
      json ? `${JSON.stringify(comparison, null, 2)}\n` : `${formatComparison(comparison)}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = runEvalCompareCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
