import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/** リポジトリの drizzle/（生成したマイグレーション） */
export const DEFAULT_MIGRATIONS_FOLDER = resolve(import.meta.dirname, "../../drizzle");

/** DB を開く。`:memory:` 以外は親ディレクトリを作る。読み取りが書き込みに妨げられないよう WAL にする */
export function openDatabase(path: string): DatabaseHandle {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

/**
 * 未適用のマイグレーションだけを適用する。
 * drizzle の同期版 migrator は全体を BEGIN〜COMMIT で包み、失敗時は ROLLBACK して例外を投げる。
 */
export function runMigrations(db: Db, migrationsFolder = DEFAULT_MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder });
}
