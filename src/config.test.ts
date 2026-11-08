import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig, parseConfig, requireEnv } from "./config.ts";

const MINIMAL = `
[llm]
base_url = "https://api.ai.sakura.ad.jp/v1"

[models]
planner = "Kimi-K2.7-Code"
implementer = "Kimi-K2.7-Code"
verifier = "Qwen3.6"
fallback = "gpt-oss-120b"

[budget]
monthly_requests = 3000
per_job_requests = 100

[github]
allowed_users = ["Coxless"]
`;

const BASE_DIR = "/srv/factory";

function issuesOf(toml: string): { path: string; message: string }[] {
  try {
    parseConfig(toml, BASE_DIR);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  throw new Error("ConfigError が投げられなかった");
}

describe("parseConfig", () => {
  test("必須項目だけの設定で成功し、省略した項目に既定値が入る", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.models.implementer).toBe("Kimi-K2.7-Code");
    expect(config.models.verifier_alt).toBeUndefined();
    expect(config.budget.timezone).toBe("Asia/Tokyo");
    expect(config.limits).toEqual({
      judge_retries: 2,
      ci_retries: 2,
      max_turns_per_phase: 40,
      job_timeout_minutes: 60,
      ci_wait_timeout_minutes: 30,
    });
    expect(config.auto_merge.max_diff_lines).toBe(300);
    expect(config.auto_merge.forbidden_paths).toContain(".github/workflows/**");
    expect(config.auto_merge.allowed_work_types).toEqual(["bugfix", "test", "docs", "refactor"]);
    expect(config.storage.database_path).toBe(resolve(BASE_DIR, "data/factory.db"));
    expect(config.storage.trace_dir).toBe(resolve(BASE_DIR, "data/traces"));
    expect(config.log.level).toBe("info");
  });

  test("返った設定は深く凍結されている", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(() => {
      (config.budget as { monthly_requests: number }).monthly_requests = 1;
    }).toThrow(TypeError);
    expect(() => {
      (config.github.allowed_users as string[]).push("someone");
    }).toThrow(TypeError);
  });

  test("必須項目がないとパス付きのエラー", () => {
    const issues = issuesOf(MINIMAL.replace('implementer = "Kimi-K2.7-Code"\n', ""));
    expect(issues).toEqual([
      { path: "/models/implementer", message: expect.stringContaining("必須") },
    ]);
  });

  test("型が違うとパスと期待する型を含むエラー", () => {
    const issues = issuesOf(
      MINIMAL.replace("monthly_requests = 3000", 'monthly_requests = "3000"'),
    );
    expect(issues).toContainEqual({
      path: "/budget/monthly_requests",
      message: expect.stringContaining("integer"),
    });
  });

  test("1ジョブの上限が月の上限を超えるとエラー", () => {
    const issues = issuesOf(MINIMAL.replace("per_job_requests = 100", "per_job_requests = 5000"));
    expect(issues).toEqual([
      { path: "/budget/per_job_requests", message: expect.stringContaining("monthly_requests") },
    ]);
  });

  test("月の上限が 0 だとエラー", () => {
    const issues = issuesOf(
      MINIMAL.replace("monthly_requests = 3000", "monthly_requests = 0").replace(
        "per_job_requests = 100",
        "per_job_requests = 1",
      ),
    );
    expect(issues).toContainEqual({
      path: "/budget/monthly_requests",
      message: expect.stringContaining("1 以上"),
    });
  });

  test("秘密情報らしい未知の項目には環境変数の案内が付く", () => {
    const issues = issuesOf(MINIMAL.replace("[llm]\n", '[llm]\napi_key = "x"\n'));
    expect(issues).toEqual([
      { path: "/llm/api_key", message: expect.stringMatching(/未知の項目.*環境変数/) },
    ]);
  });

  test("綴り間違いの表は未知の項目エラー", () => {
    const issues = issuesOf(`${MINIMAL}\n[budjet]\nx = 1\n`);
    expect(issues).toEqual([{ path: "/budjet", message: expect.stringContaining("未知の項目") }]);
  });

  test("存在しないタイムゾーンはエラー", () => {
    const issues = issuesOf(
      MINIMAL.replace("per_job_requests = 100", 'per_job_requests = 100\ntimezone = "Mars/Base"'),
    );
    expect(issues).toEqual([
      { path: "/budget/timezone", message: expect.stringContaining("Mars/Base") },
    ]);
  });

  test("https 以外の URL はエラー", () => {
    const issues = issuesOf(MINIMAL.replace("https://api", "http://api"));
    expect(issues).toEqual([
      { path: "/llm/base_url", message: expect.stringContaining("https://") },
    ]);
  });

  test("決められた以外のログレベルはエラー", () => {
    const issues = issuesOf(`${MINIMAL}\n[log]\nlevel = "verbose"\n`);
    expect(issues).toEqual([{ path: "/log/level", message: expect.stringContaining("info") }]);
  });

  test("複数の誤りはすべて報告される", () => {
    const toml = MINIMAL.replace('verifier = "Qwen3.6"\n', "")
      .replace("monthly_requests = 3000", 'monthly_requests = "x"')
      .replace("[llm]\n", '[llm]\ntoken = "x"\n');
    const paths = issuesOf(toml).map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/models/verifier", "/budget/monthly_requests", "/llm/token"]),
    );
  });

  test("エラーのメッセージに件数と各項目が並ぶ", () => {
    const toml = MINIMAL.replace('verifier = "Qwen3.6"\n', "").replace(
      "[llm]\n",
      '[llm]\ntoken = "x"\n',
    );
    try {
      parseConfig(toml, BASE_DIR);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(/2件/);
      expect((error as Error).message).toContain("/models/verifier");
    }
  });

  test("壊れた TOML は行と列を含むエラー", () => {
    const issues = issuesOf(MINIMAL.replace("[budget]", "[budget"));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/行|line/i);
  });

  test("保存先の絶対パスはそのまま使う", () => {
    const config = parseConfig(
      `${MINIMAL}\n[storage]\ndatabase_path = "/var/lib/f.db"\n`,
      BASE_DIR,
    );
    expect(config.storage.database_path).toBe("/var/lib/f.db");
  });
});

describe("loadConfig", () => {
  test("存在しないファイルはパスを含むエラー", () => {
    expect(() => loadConfig("/nonexistent/factory.toml")).toThrow(/\/nonexistent\/factory\.toml/);
  });

  test("相対パスは設定ファイルのディレクトリを基準に解決する", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-config-"));
    const file = join(dir, "factory.toml");
    writeFileSync(file, MINIMAL);
    expect(loadConfig(file).storage.database_path).toBe(join(dir, "data/factory.db"));
  });

  test("リポジトリの factory.toml は検証を通る", () => {
    const config = loadConfig(resolve(import.meta.dirname, "../factory.toml"));
    expect(config.models.fallback.length).toBeGreaterThan(0);
  });
});

describe("requireEnv", () => {
  test("値があれば返す", () => {
    process.env.FACTORY_TEST_ENV = "value";
    expect(requireEnv("FACTORY_TEST_ENV")).toBe("value");
    delete process.env.FACTORY_TEST_ENV;
  });

  test("なければ名前を含むエラー", () => {
    expect(() => requireEnv("FACTORY_TEST_MISSING")).toThrow(/FACTORY_TEST_MISSING/);
  });
});
