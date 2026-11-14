import type { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  ConfigError,
  type FactoryConfig,
  isLoopbackHost,
  loadConfig,
  requireEnv,
} from "./config.ts";
import { createGitHubClient, readPrivateKey } from "./github/client.ts";
import type { GitHubPort } from "./github/port.ts";
import { createApp } from "./http/app.ts";
import { startServer } from "./http/server.ts";
import { createWebhookHandler, type WebhookHandler } from "./http/webhook.ts";
import { apiKeyEnvOf, assertProductionProvider, createLlmModels } from "./llm/provider.ts";
import { installStreamFnGuard } from "./llm/stream.ts";
import { createLogger, type Logger } from "./log.ts";
import { type CiMonitor, createCiMonitor } from "./pipeline/ci.ts";
import { runPipelineInSandbox } from "./pipeline/run.ts";
import {
  createWorker,
  type PipelinePort,
  recoverOnStartup,
  type Worker,
  type WorkerDeps,
} from "./pipeline/worker.ts";
import { type Db, openDatabase, runMigrations } from "./queue/db.ts";
import { installDependencies, removeStaleSandboxes } from "./sandbox/docker.ts";
import { maskSecrets } from "./trace/mask.ts";

/** 動いているファクトリー。stop() は何度呼んでもよい */
export interface RunningFactory {
  address: AddressInfo;
  database: Database.Database;
  stop(): Promise<void>;
}

/** 受付と Worker が使う外の世界（007）。本物は createServices、テストでは偽物 */
export interface FactoryServices {
  github: GitHubPort;
  /** GITHUB_WEBHOOK_SECRET */
  webhookSecret: string;
  pipeline: PipelinePort;
  install: WorkerDeps["install"];
  removeSandboxes: WorkerDeps["removeSandboxes"];
  /** テストでは file:// の bare リポジトリ */
  cloneBaseUrl?: string;
}

/**
 * DB を開いてマイグレーションを適用し、HTTP の待ち受けを始める。失敗したら開いた DB を閉じて投げる。
 * makeServices を渡すと、起動時の掃除 → Worker と CI 待ちの見回りの開始 → /webhook 付きの待ち受け、の順に始める（007・009）。
 * 005 の入口は開いた DB を使うので、DB を受け取って依存を返す関数で渡す。省くと HTTP（/healthz）だけ
 */
export async function startFactory(
  config: FactoryConfig,
  logger: Logger,
  makeServices?: (db: Db) => FactoryServices,
): Promise<RunningFactory> {
  const database = config.storage.database_path;
  const handle = openDatabase(database);
  try {
    runMigrations(handle.db);
  } catch (error) {
    handle.close();
    throw new Error("マイグレーションに失敗しました", { cause: error });
  }

  let worker: Worker | undefined;
  let monitor: CiMonitor | undefined;
  let webhook: WebhookHandler | undefined;
  if (makeServices) {
    const services = makeServices(handle.db);
    const deps: WorkerDeps = {
      db: handle.db,
      config,
      logger,
      github: services.github,
      pipeline: services.pipeline,
      install: services.install,
      removeSandboxes: services.removeSandboxes,
      ...(services.cloneBaseUrl ? { cloneBaseUrl: services.cloneBaseUrl } : {}),
    };
    if (config.pipeline.install_command === "") {
      logger.warn("[pipeline].install_command が空です。依存のインストールを飛ばします");
    }
    try {
      await recoverOnStartup(deps);
    } catch (error) {
      handle.close();
      throw new Error("起動時の掃除に失敗しました", { cause: error });
    }
    const started = createWorker(deps);
    worker = started;
    // CI 待ちの見回りは Worker と別のループ（009 research R3）。やり直しの印を付けたら Worker を起こす
    const ci = createCiMonitor({ ...deps, wakeWorker: () => started.wake() });
    monitor = ci;
    webhook = createWebhookHandler({
      db: handle.db,
      config,
      logger,
      github: services.github,
      secret: services.webhookSecret,
      wake: () => started.wake(),
      wakeCi: () => ci.wake(),
    });
    started.start();
    ci.start();
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
      app: createApp({
        sqlite: handle.sqlite,
        logger,
        ...(webhook ? { webhook: webhook.app } : {}),
      }),
      host,
      port,
      shutdownTimeoutSeconds,
    });
  } catch (error) {
    await worker?.stop();
    await monitor?.stop();
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
      // Worker（処理中のジョブを中断して報告）→ CI 待ちの見回り → HTTP → 応答のあとの処理 → DB の順に止める（research R11）
      stopping ??= (async () => {
        await worker?.stop();
        await monitor?.stop();
        await server.close();
        await webhook?.idle();
        handle.close();
        logger.info("factory stopped");
      })();
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

/** 本物の GitHub・005 の入口・依存のインストール（環境変数は呼び出し側で読む） */
export function createServices(
  config: FactoryConfig,
  logger: Logger,
  env: { appId: string; privateKey: string; webhookSecret: string; apiKey: string },
  db: Db,
): FactoryServices {
  const gate = { db, config, models: createLlmModels(config), logger, apiKey: env.apiKey };
  const pipeline: PipelinePort = (input) => runPipelineInSandbox({ gate }, input);
  return {
    github: createGitHubClient({ appId: env.appId, privateKey: env.privateKey }),
    webhookSecret: env.webhookSecret,
    pipeline,
    install: async (jobId, workdir) => {
      const result = await installDependencies({
        jobId,
        workspace: workdir,
        sandbox: config.sandbox,
        command: ["sh", "-c", config.pipeline.install_command],
      });
      const stderr = new TextDecoder().decode(result.stderr);
      return { exitCode: result.exitCode, stderrTail: maskSecrets(stderr.slice(-2000)) };
    },
    removeSandboxes: async (jobId) => {
      await removeStaleSandboxes(jobId === undefined ? {} : { jobId });
    },
  };
}

/** 起動処理: 設定 → 環境変数 → ログ → DB とマイグレーション → 起動時の掃除 → Worker → HTTP。停止の合図まで動く */
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

  let env: Parameters<typeof createServices>[2];
  try {
    env = {
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey: readPrivateKey(requireEnv("GITHUB_APP_PRIVATE_KEY_PATH")),
      webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
      apiKey: requireEnv(apiKeyEnvOf(config)),
    };
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const logger: Logger = createLogger({ level: config.log.level });
  let factory: RunningFactory;
  try {
    factory = await startFactory(config, logger, (db) => createServices(config, logger, env, db));
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
