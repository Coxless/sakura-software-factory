import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLogger } from "./log.ts";

const TOKEN = "ghp_aBcD1234567890aBcD1234567890aBcD12";

function capture(level: Parameters<typeof createLogger>[0]["level"] = "info") {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({ level }, stream);
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

describe("createLogger", () => {
  test("1行1件の JSON で time・level・msg を含む", () => {
    const { logger, lines, records } = capture();
    logger.info("factory started");
    expect(lines).toHaveLength(1);
    expect(records()[0]).toMatchObject({ level: 30, msg: "factory started" });
    expect(typeof records()[0]?.time).toBe("number");
  });

  test("子ロガーの文脈が出力に入る", () => {
    const { logger, records } = capture();
    logger.child({ job_id: 42 }).info("claimed");
    expect(records()[0]).toMatchObject({ job_id: 42, msg: "claimed" });
  });

  test("秘密情報の項目名の値は出力に現れない", () => {
    const { logger, lines } = capture();
    logger.info({ headers: { authorization: "Bearer secret-value-1" } }, "request");
    logger.info({ api_key: "secret-value-2", nested: { token: "secret-value-3" } }, "keys");
    logger.info({ config: { apiKey: "secret-value-4", password: "secret-value-5" } }, "more");
    const output = lines.join("\n");
    for (let i = 1; i <= 5; i++) expect(output).not.toContain(`secret-value-${i}`);
  });

  test("値の形で秘密情報を伏せる（メッセージ・エラー・入れ子）", () => {
    const { logger, lines } = capture();
    logger.info(`push with ${TOKEN}`);
    logger.error({ err: new Error(`clone failed: ${TOKEN}`) }, "git error");
    logger.warn({ a: { b: ["x", `Bearer ${TOKEN}`] } }, "nested");
    logger.info("format %s", TOKEN);
    const output = lines.join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("clone failed");
  });

  test("循環参照を含むオブジェクトでも例外にならない", () => {
    const { logger, lines } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(() => logger.info({ loop }, "circular")).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  test("設定より低いレベルは出力されない", () => {
    const { logger, records } = capture("warn");
    logger.info("hidden");
    logger.warn("shown");
    expect(records().map((record) => record.msg)).toEqual(["shown"]);
  });
});
