/**
 * pnpm run status:dev: 設定の DB を読み取り専用で開き、状況ページ（GET /status）と同じ集計を出す（011）。
 * 常駐のファクトリーは開発用の設定では起動しないので、ローカルではこれで確かめる。LLM を呼ばず、DB に書かない。
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { type FactoryConfig, loadConfig } from "./config.ts";
import * as schema from "./queue/schema.ts";
import { collectStatus } from "./status/collect.ts";
import { renderStatusHtml } from "./status/render.ts";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export const DEFAULT_DEV_CONFIG = "./factory.dev.toml";

export interface StatusDevIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  loadConfig?: () => FactoryConfig;
  now?: () => number;
}

export async function runStatusDevCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: StatusDevIo,
): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let htmlOut: boolean;
  try {
    const parsed = parseArgs({
      args,
      options: { html: { type: "boolean", default: false } },
      strict: true,
    });
    htmlOut = parsed.values.html === true;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr("使い方: pnpm run status:dev [-- --html]\n");
    return EXIT_ERROR;
  }

  let sqlite: Database.Database | undefined;
  try {
    const config = (
      io.loadConfig ?? (() => loadConfig(env.FACTORY_CONFIG ?? DEFAULT_DEV_CONFIG))
    )();
    // 読み取り専用。DB がなければ作らずに止める（マイグレーションもしない）
    sqlite = new Database(config.storage.database_path, { readonly: true, fileMustExist: true });
    const snapshot = collectStatus(drizzle(sqlite, { schema }), {
      now: (io.now ?? Date.now)(),
      timeZone: config.budget.timezone,
      monthlyLimit: config.budget.monthly_requests,
    });
    io.stdout(
      htmlOut ? await renderStatusHtml(snapshot) : `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  } finally {
    sqlite?.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  process.exitCode = await runStatusDevCli(process.argv.slice(2), process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
