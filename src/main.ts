import { ConfigError, type FactoryConfig, loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";

/** 起動処理: 設定 → ログ → DB を開いてマイグレーション。HTTP と Worker は 006・007 で足す */
function main(): number {
  let config: FactoryConfig;
  try {
    config = loadConfig();
  } catch (error) {
    // ロガーは設定のログレベルで作るので、設定の失敗は標準エラーに出す
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    return 1;
  }

  const logger: Logger = createLogger({ level: config.log.level });
  try {
    const handle = openDatabase(config.storage.database_path);
    try {
      runMigrations(handle.db);
    } finally {
      handle.close();
    }
  } catch (error) {
    logger.fatal(
      { err: error, database: config.storage.database_path },
      "マイグレーションに失敗しました",
    );
    return 1;
  }

  logger.info({ database: config.storage.database_path, models: config.models }, "factory started");
  return 0;
}

process.exitCode = main();
