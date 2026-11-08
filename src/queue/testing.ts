import { openDatabase, runMigrations } from "./db.ts";

/** テスト用: マイグレーション済みのメモリ上の DB */
export function migratedMemoryDb() {
  const handle = openDatabase(":memory:");
  runMigrations(handle.db);
  return handle;
}
