import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";

/** pnpm run db:migrate: 未適用のマイグレーションだけを適用して終了する */
function migrateCommand(): number {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    return 1;
  }

  const logger = createLogger({ level: config.log.level });
  const database = config.storage.database_path;
  try {
    const handle = openDatabase(database);
    try {
      runMigrations(handle.db);
    } finally {
      handle.close();
    }
  } catch (error) {
    logger.fatal(
      { err: error, database },
      "マイグレーションに失敗しました（変更は残していません）",
    );
    return 1;
  }
  logger.info({ database }, "マイグレーションを適用しました");
  return 0;
}

process.exitCode = migrateCommand();
