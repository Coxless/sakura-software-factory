import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type FactoryConfig, parseConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { installSignalHandlers, startFactory } from "./main.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** port は設定では 1 以上なので、テストでは空いているポート（0）に差し替える */
function configWith(dir: string, host = "127.0.0.1", port = 0): FactoryConfig {
  const config = parseConfig(
    `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"
[models]
planner = "p"
implementer = "i"
verifier = "v"
fallback = "f"
[budget]
monthly_requests = 3000
per_job_requests = 100
[github]
allowed_users = ["Coxless"]
[storage]
database_path = "factory.db"
[http]
host = "${host}"
shutdown_timeout_seconds = 1
`,
    dir,
  );
  return { ...config, http: { ...config.http, port } };
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({ level: "info" }, stream);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, records };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-main-"));
  dirs.push(dir);
  return dir;
}

describe("startFactory", () => {
  test("マイグレーションのあと待ち受け、/healthz が 200。stop() で DB を閉じる", async () => {
    const { logger, records } = capture();
    const factory = await startFactory(configWith(tempDir()), logger);
    const res = await fetch(`http://127.0.0.1:${factory.address.port}/healthz`);
    expect(res.status).toBe(200);
    expect(records().find((record) => record.msg === "factory started")).toMatchObject({
      http: { host: "127.0.0.1", port: factory.address.port },
    });

    await factory.stop();
    expect(factory.database.open).toBe(false);
    expect(records().some((record) => record.msg === "factory stopped")).toBe(true);
    await expect(factory.stop()).resolves.toBeUndefined();
  });

  test("ループバック以外で待ち受けると warn を出す", async () => {
    const { logger, records } = capture();
    const factory = await startFactory(configWith(tempDir(), "0.0.0.0"), logger);
    await factory.stop();
    expect(records().filter((record) => record.level === 40)).toEqual([
      expect.objectContaining({ msg: expect.stringContaining("Caddy を通さずに公開") }),
    ]);
  });

  test("待ち受けに失敗したら DB を閉じて投げる", async () => {
    const { logger } = capture();
    const first = await startFactory(configWith(tempDir()), logger);
    const port = first.address.port;
    await expect(startFactory(configWith(tempDir(), "127.0.0.1", port), logger)).rejects.toThrow(
      `127.0.0.1:${port}`,
    );
    await first.stop();
  });
});

describe("installSignalHandlers", () => {
  test("1回目の合図で stop() してから 0 で終わる", async () => {
    const signals = new EventEmitter();
    const stop = vi.fn(async () => {});
    const exit = vi.fn();
    installSignalHandlers({ signals, stop, exit });
    signals.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("停止中の2回目の合図で即座に終わる（SIGINT は 130、SIGTERM は 143）", async () => {
    const signals = new EventEmitter();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    installSignalHandlers({ signals, stop, exit });
    signals.emit("SIGINT", "SIGINT");
    signals.emit("SIGINT", "SIGINT");
    expect(exit).toHaveBeenCalledWith(130);

    const signals2 = new EventEmitter();
    const exit2 = vi.fn();
    installSignalHandlers({ signals: signals2, stop, exit: exit2 });
    signals2.emit("SIGTERM", "SIGTERM");
    signals2.emit("SIGTERM", "SIGTERM");
    expect(exit2).toHaveBeenCalledWith(143);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test("stop() が失敗したら 1 で終わる", async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    installSignalHandlers({ signals, stop: async () => Promise.reject(new Error("x")), exit });
    signals.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
