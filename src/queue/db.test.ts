import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openDatabase, runMigrations } from "./db.ts";

const TABLES = ["agent_runs", "budget", "deployments", "job_events", "jobs", "llm_calls"];

function userTables(handle: ReturnType<typeof openDatabase>): string[] {
  return (
    handle.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe("openDatabase / runMigrations", () => {
  test("親ディレクトリがなければ作り、6つのテーブルを用意する", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-db-"));
    const path = join(dir, "nested/deeper/factory.db");
    const handle = openDatabase(path);
    runMigrations(handle.db);
    expect(userTables(handle)).toEqual(TABLES);
    expect(handle.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    handle.close();
  });

  test("2回目の適用でエラーにならず、既存の行は変わらない", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-db-"));
    const path = join(dir, "factory.db");
    const first = openDatabase(path);
    runMigrations(first.db);
    first.sqlite
      .prepare("INSERT INTO budget (month, monthly_limit, created_at) VALUES ('2026-11', 3000, 1)")
      .run();
    first.close();

    const second = openDatabase(path);
    runMigrations(second.db);
    expect(second.sqlite.prepare("SELECT * FROM budget").all()).toEqual([
      { month: "2026-11", monthly_limit: 3000, intake_stopped_at: null, created_at: 1 },
    ]);
    second.close();
  });

  test("途中で失敗したマイグレーションは変更を残さない", () => {
    const folder = mkdtempSync(join(tmpdir(), "factory-broken-migrations-"));
    mkdirSync(join(folder, "meta"));
    writeFileSync(
      join(folder, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [{ idx: 0, version: "6", when: 1, tag: "0000_broken", breakpoints: true }],
      }),
    );
    writeFileSync(
      join(folder, "0000_broken.sql"),
      "CREATE TABLE ok_table (id integer);\n--> statement-breakpoint\nTHIS IS NOT SQL;",
    );

    const handle = openDatabase(":memory:");
    expect(() => runMigrations(handle.db, folder)).toThrow();
    expect(userTables(handle)).toEqual([]);
    handle.close();
  });
});
