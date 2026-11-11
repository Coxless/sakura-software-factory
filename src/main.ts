import type { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { ConfigError, type FactoryConfig, isLoopbackHost, loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { startServer } from "./http/server.ts";
import { assertProductionProvider } from "./llm/provider.ts";
import { installStreamFnGuard } from "./llm/stream.ts";
import { createLogger, type Logger } from "./log.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";

/** 動いているファクトリー。stop() は何度呼んでもよい */
export interface RunningFactory {
  address: AddressInfo;
  database: Database.Database;
  stop(): Promise<void>;
}

/**
 * DB を開いてマイグレーションを適用し、HTTP の待ち受けを始める。
 * 失敗したら開いた DB を閉じて投げる。Worker は 007 で足す
 */
export async function startFactory(config: FactoryConfig, logger: Logger): Promise<RunningFactory> {
  const database = config.storage.database_path;
  const handle = openDatabase(database);
  try {
    runMigrations(handle.db);
  } catch (error) {
    handle.close();
    throw new Error("マイグレーションに失敗しました", { cause: error });
  }

  const { host, port, shutdown_timeout_seconds: shutdownTimeoutSeconds } = config.http;
  if (!isLoopbackHost(host)) {
    logger.warn(
      { http: { host, port } },
      "Caddy を通さずに公開しています（host がループバックではありません）",
    );
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({
      app: createApp({ sqlite: handle.sqlite, logger }),
      host,
      port,
      shutdownTimeoutSeconds,
    });
  } catch (error) {
    handle.close();
    throw error;
  }

  logger.info(
    { database, models: config.models, http: { host, port: server.address.port } },
    "factory started",
  );

  let stopping: Promise<void> | undefined;
  return {
    address: server.address,
    database: handle.sqlite,
    stop() {
      stopping ??= server.close().then(() => {
        handle.close();
        logger.info("factory stopped");
      });
      return stopping;
    },
  };
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
type StopSignal = keyof typeof SIGNAL_EXIT_CODES;

export interface SignalHandlerDeps {
  signals: EventEmitter;
  stop: () => Promise<void>;
  exit: (code: number) => void;
}

/** 1回目の合図で stop() してから 0 で終わる。停止中の2回目の合図では即座に終わる */
export function installSignalHandlers({ signals, stop, exit }: SignalHandlerDeps): void {
  let stopping = false;
  const onSignal = (signal: StopSignal) => {
    if (stopping) {
      exit(SIGNAL_EXIT_CODES[signal]);
      return;
    }
    stopping = true;
    stop().then(
      () => exit(0),
      (error: unknown) => {
        process.stderr.write(`停止処理に失敗しました: ${String(error)}\n`);
        exit(1);
      },
    );
  };
  for (const signal of Object.keys(SIGNAL_EXIT_CODES) as StopSignal[]) {
    signals.on(signal, onSignal);
  }
}

/** 起動処理: 設定 → ログ → DB を開いてマイグレーション → HTTP の待ち受け。停止の合図まで動く */
async function main(): Promise<number> {
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
  let factory: RunningFactory;
  try {
    factory = await startFactory(config, logger);
  } catch (error) {
    logger.fatal({ err: error, database: config.storage.database_path }, "起動に失敗しました");
    return 1;
  }
  installSignalHandlers({
    signals: process,
    stop: factory.stop,
    exit: (code) => process.exit(code),
  });
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  const code = await main();
  if (code !== 0) process.exitCode = code;
}
