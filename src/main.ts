import { ConfigError, type FactoryConfig, loadConfig } from "./config.ts";
import { assertProductionProvider } from "./llm/provider.ts";
import { installStreamFnGuard } from "./llm/stream.ts";
import { createLogger, type Logger } from "./log.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";

/** 起動処理: 設定 → ログ → DB を開いてマイグレーション。HTTP と Worker は 006・007 で足す */
function main(): number {
  // LLM 呼び出しはすべて予算ゲートを通す。Agent に streamFn を渡し忘れても素通りさせない
  installStreamFnGuard();
  let config: FactoryConfig;
  try {
    config = loadConfig();
    // 常駐するファクトリーの推論は さくら だけ（原則 I）。開発用の Google AI Studio の設定では起動しない
    assertProductionProvider(config);
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
