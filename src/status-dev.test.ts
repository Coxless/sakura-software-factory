import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Value from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import { type FactoryConfig, loadConfig } from "./config.ts";
import { openDatabase, runMigrations } from "./queue/db.ts";
import { StatusSnapshotSchema } from "./status/schema.ts";
import { createSeeder } from "./status/testing.ts";
import { EXIT_ERROR, EXIT_OK, runStatusDevCli } from "./status-dev.ts";

const NOW = Date.UTC(2026, 10, 14, 3);
const IN = Date.UTC(2026, 9, 31, 15) + 60_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function configWithDb(path: string): () => FactoryConfig {
  return () => {
    const config = loadConfig("./factory.dev.toml");
    return { ...config, storage: { ...config.storage, database_path: path } };
  };
}

function prepareDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "status-dev-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "factory.db");
  const handle = openDatabase(path);
  runMigrations(handle.db);
  const seed = createSeeder(handle.db);
  for (let i = 0; i < 3; i++) seed.llmCall({ created_at: IN });
  handle.close();
  return path;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), now: () => NOW },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("pnpm run status:dev", () => {
  test("JSON を出し、DB の中身を変えない", async () => {
    const path = prepareDb();
    const before = digest(path);
    const c = capture();
    const code = await runStatusDevCli([], {}, { ...c.io, loadConfig: configWithDb(path) });
    expect(c.err()).toBe("");
    expect(code).toBe(EXIT_OK);
    const body = JSON.parse(c.out());
    expect(Value.Check(StatusSnapshotSchema, body)).toBe(true);
    expect(body.consumption.requests).toBe(3);
    expect(digest(path)).toBe(before);
  });

  test("--html で HTML を出す", async () => {
    const path = prepareDb();
    const c = capture();
    const code = await runStatusDevCli(
      ["--", "--html"],
      {},
      {
        ...c.io,
        loadConfig: configWithDb(path),
      },
    );
    expect(code).toBe(EXIT_OK);
    expect(c.out()).toMatch(/^<!doctype html>/);
    expect(c.out()).toContain("3 / ");
  });

  test("DB がなければ作らずに終了コード 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "status-dev-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "missing.db");
    const c = capture();
    const code = await runStatusDevCli([], {}, { ...c.io, loadConfig: configWithDb(path) });
    expect(code).toBe(EXIT_ERROR);
    expect(existsSync(path)).toBe(false);
    expect(c.err()).not.toBe("");
  });

  test("知らない引数は終了コード 1", async () => {
    const c = capture();
    expect(await runStatusDevCli(["--bogus"], {}, c.io)).toBe(EXIT_ERROR);
    expect(c.err()).toContain("使い方");
  });
});
