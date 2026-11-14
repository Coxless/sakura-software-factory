import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ConfigError,
  DEFAULT_DENY_WRITE_PATHS,
  isLoopbackHost,
  loadConfig,
  parseConfig,
  requireEnv,
  WORK_TYPES,
} from "./config.ts";

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

describe("parseConfig: [sandbox] と [tools]（003）", () => {
  test("省略すると既定値が入る", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.sandbox).toEqual({
      image: "factory-sandbox:latest",
      cpus: 2,
      memory_mb: 2048,
      pids_limit: 512,
      tmp_size_mb: 512,
      install_timeout_seconds: 600,
    });
    expect(config.sandbox.user).toBeUndefined();
    expect(config.tools).toEqual({
      bash_timeout_seconds: 120,
      bash_max_timeout_seconds: 600,
      read_max_lines: 2000,
      max_output_chars: 20000,
      deny_write_paths: [...DEFAULT_DENY_WRITE_PATHS],
    });
    expect(config.tools.deny_write_paths).toContain(".git/**");
  });

  test("値を指定できる", () => {
    const config = parseConfig(
      `${MINIMAL}\n[sandbox]\nuser = "1001:1001"\ncpus = 0.5\n[tools]\ndeny_write_paths = ["x/**"]\n`,
      BASE_DIR,
    );
    expect(config.sandbox.user).toBe("1001:1001");
    expect(config.sandbox.cpus).toBe(0.5);
    expect(config.tools.deny_write_paths).toEqual(["x/**"]);
  });

  test("uid 0 と形の違う user はエラー", () => {
    expect(issuesOf(`${MINIMAL}\n[sandbox]\nuser = "0:0"\n`)).toEqual([
      { path: "/sandbox/user", message: expect.stringContaining("uid は 0 以外") },
    ]);
    expect(issuesOf(`${MINIMAL}\n[sandbox]\nuser = "node"\n`)).toEqual([
      { path: "/sandbox/user", message: expect.stringContaining("形式") },
    ]);
  });

  test("cpus は 0 より大きい", () => {
    expect(issuesOf(`${MINIMAL}\n[sandbox]\ncpus = 0\n`)).toEqual([
      { path: "/sandbox/cpus", message: expect.stringContaining("より大きく") },
    ]);
  });

  test("bash_timeout_seconds は bash_max_timeout_seconds 以下", () => {
    expect(issuesOf(`${MINIMAL}\n[tools]\nbash_timeout_seconds = 900\n`)).toEqual([
      {
        path: "/tools/bash_timeout_seconds",
        message: "bash_max_timeout_seconds（600）以下にしてください（現在 900）",
      },
    ]);
  });

  test("未知の項目はエラー", () => {
    expect(issuesOf(`${MINIMAL}\n[sandbox]\nnetwork = "host"\n`)).toEqual([
      { path: "/sandbox/network", message: expect.stringContaining("未知") },
    ]);
  });
});

describe("parseConfig: [http]（006）", () => {
  test("省略すると既定値が入る", () => {
    expect(parseConfig(MINIMAL, BASE_DIR).http).toEqual({
      host: "127.0.0.1",
      port: 8787,
      shutdown_timeout_seconds: 10,
    });
  });

  test("値を指定できる", () => {
    const config = parseConfig(
      `${MINIMAL}\n[http]\nhost = "::1"\nport = 9000\nshutdown_timeout_seconds = 60\n`,
      BASE_DIR,
    );
    expect(config.http).toEqual({ host: "::1", port: 9000, shutdown_timeout_seconds: 60 });
  });

  test("port は 1〜65535", () => {
    expect(issuesOf(`${MINIMAL}\n[http]\nport = 0\n`)).toEqual([
      { path: "/http/port", message: "1 以上にしてください" },
    ]);
    expect(issuesOf(`${MINIMAL}\n[http]\nport = 65536\n`)).toEqual([
      { path: "/http/port", message: "65535 以下にしてください" },
    ]);
  });

  test("shutdown_timeout_seconds は 1〜60", () => {
    expect(issuesOf(`${MINIMAL}\n[http]\nshutdown_timeout_seconds = 0\n`)).toEqual([
      { path: "/http/shutdown_timeout_seconds", message: "1 以上にしてください" },
    ]);
    expect(issuesOf(`${MINIMAL}\n[http]\nshutdown_timeout_seconds = 61\n`)).toEqual([
      { path: "/http/shutdown_timeout_seconds", message: "60 以下にしてください" },
    ]);
  });

  test("空の host はエラー", () => {
    expect(issuesOf(`${MINIMAL}\n[http]\nhost = ""\n`)).toEqual([
      { path: "/http/host", message: "1 文字以上にしてください" },
    ]);
  });

  test("未知の項目はエラー", () => {
    expect(issuesOf(`${MINIMAL}\n[http]\ntls = true\n`)).toEqual([
      { path: "/http/tls", message: expect.stringContaining("未知") },
    ]);
  });
});

describe("isLoopbackHost", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["::1", true],
    ["localhost", true],
    ["0.0.0.0", false],
    ["::", false],
    ["192.168.0.10", false],
    ["factory.example.jp", false],
  ])("%s → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("parseConfig: [implementer]（004）", () => {
  test("省略すると既定値が入る", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.implementer).toEqual({
      max_consecutive_blocks: 5,
      compaction_ratio: 0.7,
      keep_recent_turns: 4,
      max_agents_md_chars: 20000,
      max_issue_chars: 20000,
      max_plan_chars: 20000,
      max_feedback_chars: 30000,
    });
  });

  test("値を指定できる", () => {
    const config = parseConfig(
      `${MINIMAL}\n[implementer]\ncompaction_ratio = 0.5\nkeep_recent_turns = 2\n`,
      BASE_DIR,
    );
    expect(config.implementer.compaction_ratio).toBe(0.5);
    expect(config.implementer.keep_recent_turns).toBe(2);
  });

  test.each([
    ["max_consecutive_blocks = 0", "/implementer/max_consecutive_blocks", "1 以上"],
    ["max_consecutive_blocks = 51", "/implementer/max_consecutive_blocks", "50 以下"],
    ["compaction_ratio = 0.2", "/implementer/compaction_ratio", "0.3 以上"],
    ["compaction_ratio = 0.96", "/implementer/compaction_ratio", "0.95 以下"],
    ["keep_recent_turns = 0", "/implementer/keep_recent_turns", "1 以上"],
    ["keep_recent_turns = 21", "/implementer/keep_recent_turns", "20 以下"],
    ["max_agents_md_chars = 999", "/implementer/max_agents_md_chars", "1000 以上"],
    ["max_issue_chars = 200001", "/implementer/max_issue_chars", "200000 以下"],
    ["max_plan_chars = 999", "/implementer/max_plan_chars", "1000 以上"],
    ["max_feedback_chars = 200001", "/implementer/max_feedback_chars", "200000 以下"],
  ])("範囲外はエラー: %s", (line, path, message) => {
    expect(issuesOf(`${MINIMAL}\n[implementer]\n${line}\n`)).toEqual([
      { path, message: expect.stringContaining(message) },
    ]);
  });

  test("未知の項目はエラー", () => {
    expect(issuesOf(`${MINIMAL}\n[implementer]\nmax_turns = 10\n`)).toEqual([
      { path: "/implementer/max_turns", message: expect.stringContaining("未知") },
    ]);
  });
});

describe("parseConfig: [pipeline]（005）", () => {
  test("省略すると既定値が入る", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.pipeline).toEqual({
      check_commands: ["pnpm run check"],
      check_timeout_seconds: 600,
      max_check_feedbacks: 3,
      max_check_log_chars: 8000,
      max_diff_chars: 40000,
      max_file_list_chars: 10000,
      install_command: "pnpm install --frozen-lockfile",
      max_ci_log_chars: 12000,
    });
  });

  test("コマンドの一覧は空にできる", () => {
    const config = parseConfig(`${MINIMAL}\n[pipeline]\ncheck_commands = []\n`, BASE_DIR);
    expect(config.pipeline.check_commands).toEqual([]);
  });

  test.each([
    ["check_timeout_seconds = 9", "/pipeline/check_timeout_seconds", "10 以上"],
    ["check_timeout_seconds = 3601", "/pipeline/check_timeout_seconds", "3600 以下"],
    ["max_check_feedbacks = -1", "/pipeline/max_check_feedbacks", "0 以上"],
    ["max_check_feedbacks = 11", "/pipeline/max_check_feedbacks", "10 以下"],
    ["max_check_log_chars = 999", "/pipeline/max_check_log_chars", "1000 以上"],
    ["max_check_log_chars = 100001", "/pipeline/max_check_log_chars", "100000 以下"],
    ["max_diff_chars = 999", "/pipeline/max_diff_chars", "1000 以上"],
    ["max_diff_chars = 400001", "/pipeline/max_diff_chars", "400000 以下"],
    ["max_file_list_chars = 999", "/pipeline/max_file_list_chars", "1000 以上"],
    ["max_file_list_chars = 100001", "/pipeline/max_file_list_chars", "100000 以下"],
    ['check_commands = [""]', "/pipeline/check_commands/0", "1 文字以上"],
  ])("範囲外はエラー: %s", (line, path, message) => {
    expect(issuesOf(`${MINIMAL}\n[pipeline]\n${line}\n`)).toEqual([
      { path, message: expect.stringContaining(message) },
    ]);
  });

  test("未知の項目はエラー", () => {
    expect(issuesOf(`${MINIMAL}\n[pipeline]\nretries = 1\n`)).toEqual([
      { path: "/pipeline/retries", message: expect.stringContaining("未知") },
    ]);
  });

  test("allowed_work_types は作業の種類の一覧の値だけ", () => {
    expect(WORK_TYPES).toEqual(["bugfix", "test", "docs", "refactor", "feature", "chore"]);
    expect(
      parseConfig(`${MINIMAL}\n[auto_merge]\nallowed_work_types = ["feature", "chore"]\n`, BASE_DIR)
        .auto_merge.allowed_work_types,
    ).toEqual(["feature", "chore"]);
    expect(
      issuesOf(`${MINIMAL}\n[auto_merge]\nallowed_work_types = ["bugfix", "hotfix"]\n`),
    ).toEqual([
      { path: "/auto_merge/allowed_work_types/1", message: expect.stringContaining("hotfix") },
    ]);
  });
});

describe("parseConfig: 自動マージの条件（008）", () => {
  test("省略すると skip_label と既定の禁止パスが入る", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.auto_merge.skip_label).toBe("no-auto-merge");
    expect(config.auto_merge.forbidden_paths).toEqual(
      expect.arrayContaining([".github/workflows/**", ".gitleaks.toml", ".gitleaksignore"]),
    );
  });

  test("skip_label は空でない 50 文字以下", () => {
    expect(
      parseConfig(`${MINIMAL}\n[auto_merge]\nskip_label = "hold"\n`, BASE_DIR).auto_merge
        .skip_label,
    ).toBe("hold");
    expect(issuesOf(`${MINIMAL}\n[auto_merge]\nskip_label = ""\n`)).toEqual([
      { path: "/auto_merge/skip_label", message: expect.any(String) },
    ]);
    expect(issuesOf(`${MINIMAL}\n[auto_merge]\nskip_label = "${"a".repeat(51)}"\n`)).toEqual([
      { path: "/auto_merge/skip_label", message: expect.any(String) },
    ]);
  });

  test("max_diff_lines は 1 以上", () => {
    expect(issuesOf(`${MINIMAL}\n[auto_merge]\nmax_diff_lines = 0\n`)).toEqual([
      { path: "/auto_merge/max_diff_lines", message: expect.any(String) },
    ]);
  });
});

describe("parseConfig: CI連携（009）", () => {
  test("省略すると既定値が入る", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.worker.ci_check_interval_seconds).toBe(60);
    expect(config.pipeline.max_ci_log_chars).toBe(12000);
  });

  test("値を指定できる", () => {
    const config = parseConfig(
      `${MINIMAL}\n[worker]\nci_check_interval_seconds = 10\n\n[pipeline]\nmax_ci_log_chars = 1000\n`,
      BASE_DIR,
    );
    expect(config.worker.ci_check_interval_seconds).toBe(10);
    expect(config.pipeline.max_ci_log_chars).toBe(1000);
  });

  test.each([
    ["worker", "ci_check_interval_seconds = 9", "/worker/ci_check_interval_seconds", "10 以上"],
    [
      "worker",
      "ci_check_interval_seconds = 3601",
      "/worker/ci_check_interval_seconds",
      "3600 以下",
    ],
    ["pipeline", "max_ci_log_chars = 999", "/pipeline/max_ci_log_chars", "1000 以上"],
    ["pipeline", "max_ci_log_chars = 100001", "/pipeline/max_ci_log_chars", "100000 以下"],
  ])("[%s] %s はエラー", (section, line, path, message) => {
    expect(issuesOf(`${MINIMAL}\n[${section}]\n${line}\n`)).toEqual([
      { path, message: expect.stringContaining(message) },
    ]);
  });
});

describe("parseConfig: 受付と Worker（007）", () => {
  test("省略すると既定値が入り、work_dir は設定ファイルの場所が基準", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.github).toEqual({
      allowed_users: ["Coxless"],
      webhook_max_body_kb: 1024,
      max_instruction_chars: 20000,
    });
    expect(config.worker).toEqual({ poll_interval_seconds: 5, ci_check_interval_seconds: 60 });
    expect(config.storage.work_dir).toBe(resolve(BASE_DIR, "data/work"));
    expect(config.pipeline.install_command).toBe("pnpm install --frozen-lockfile");
  });

  test("値を指定できる。install_command は空にできる", () => {
    const config = parseConfig(
      `${MINIMAL.replace('allowed_users = ["Coxless"]', 'allowed_users = ["Coxless"]\nwebhook_max_body_kb = 64\nmax_instruction_chars = 100')}
[worker]
poll_interval_seconds = 300

[storage]
work_dir = "/var/lib/sakura-factory/work"

[pipeline]
install_command = ""
`,
      BASE_DIR,
    );
    expect(config.github.webhook_max_body_kb).toBe(64);
    expect(config.github.max_instruction_chars).toBe(100);
    expect(config.worker.poll_interval_seconds).toBe(300);
    expect(config.storage.work_dir).toBe("/var/lib/sakura-factory/work");
    expect(config.pipeline.install_command).toBe("");
  });

  test.each([
    ["github", "webhook_max_body_kb = 63", "/github/webhook_max_body_kb", "64 以上"],
    ["github", "webhook_max_body_kb = 25601", "/github/webhook_max_body_kb", "25600 以下"],
    ["github", "max_instruction_chars = 99", "/github/max_instruction_chars", "100 以上"],
    ["github", "max_instruction_chars = 200001", "/github/max_instruction_chars", "200000 以下"],
    ["worker", "poll_interval_seconds = 0", "/worker/poll_interval_seconds", "1 以上"],
    ["worker", "poll_interval_seconds = 301", "/worker/poll_interval_seconds", "300 以下"],
    ["storage", 'work_dir = ""', "/storage/work_dir", "1 文字以上"],
    ["storage", 'eval_dir = ""', "/storage/eval_dir", "1 文字以上"],
  ])("[%s] %s はエラー", (section, line, path, message) => {
    const toml =
      section === "github"
        ? MINIMAL.replace('allowed_users = ["Coxless"]', `allowed_users = ["Coxless"]\n${line}`)
        : `${MINIMAL}\n[${section}]\n${line}\n`;
    expect(issuesOf(toml)).toEqual([{ path, message: expect.stringContaining(message) }]);
  });

  test("未知の項目はエラー", () => {
    expect(issuesOf(`${MINIMAL}\n[worker]\nconcurrency = 2\n`)).toEqual([
      { path: "/worker/concurrency", message: expect.stringContaining("未知") },
    ]);
  });
});

describe("parseConfig の [llm]（002）", () => {
  const withLlm = (lines: string) =>
    MINIMAL.replace(
      'base_url = "https://api.ai.sakura.ad.jp/v1"',
      `base_url = "https://api.ai.sakura.ad.jp/v1"\n${lines}`,
    );

  test("省略するとリトライ・待ち時間・応答の時間の上限に既定値が入る", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.llm).toEqual({
      provider: "sakura",
      base_url: "https://api.ai.sakura.ad.jp/v1",
      max_attempts: 3,
      max_retry_delay_seconds: 60,
      request_timeout_seconds: 300,
    });
  });

  test("指定した値はそのまま使う", () => {
    const config = parseConfig(
      withLlm("max_attempts = 5\nmax_retry_delay_seconds = 10\nrequest_timeout_seconds = 30"),
      BASE_DIR,
    );
    expect(config.llm.max_attempts).toBe(5);
    expect(config.llm.max_retry_delay_seconds).toBe(10);
    expect(config.llm.request_timeout_seconds).toBe(30);
  });

  test.each([
    ["max_attempts", 0, "1 以上"],
    ["max_attempts", 11, "10 以下"],
    ["max_retry_delay_seconds", 0, "1 以上"],
    ["max_retry_delay_seconds", 601, "600 以下"],
    ["request_timeout_seconds", 9, "10 以上"],
    ["request_timeout_seconds", 1801, "1800 以下"],
  ])("%s = %i は範囲外としてパス付きのエラー", (name, value, message) => {
    expect(issuesOf(withLlm(`${name} = ${value}`))).toEqual([
      { path: `/llm/${name}`, message: expect.stringContaining(message) },
    ]);
  });

  test("provider に google-ai-studio を指定できる（開発用）", () => {
    const config = parseConfig(withLlm('provider = "google-ai-studio"'), BASE_DIR);
    expect(config.llm.provider).toBe("google-ai-studio");
  });

  test("決められた以外の provider はエラー", () => {
    expect(issuesOf(withLlm('provider = "openai"'))).toEqual([
      { path: "/llm/provider", message: expect.stringContaining("sakura") },
    ]);
  });

  test("[llm] の未知の項目はエラー", () => {
    expect(issuesOf(withLlm("max_retries = 3"))).toEqual([
      { path: "/llm/max_retries", message: expect.stringContaining("未知の項目") },
    ]);
  });
});

describe("parseConfig: 回帰評価（012）", () => {
  test("eval_dir を省略すると data/evals を設定ファイルの場所が基準の絶対パスにする", () => {
    const config = parseConfig(MINIMAL, BASE_DIR);
    expect(config.storage.eval_dir).toBe(resolve(BASE_DIR, "data/evals"));
  });

  test("eval_dir を指定できる（相対パスは設定ファイルの場所が基準）", () => {
    const config = parseConfig(`${MINIMAL}\n[storage]\neval_dir = "out/evals"\n`, BASE_DIR);
    expect(config.storage.eval_dir).toBe(resolve(BASE_DIR, "out/evals"));
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

  test("リポジトリの factory.toml は検証を通り、提供元は さくら", () => {
    const config = loadConfig(resolve(import.meta.dirname, "../factory.toml"));
    expect(config.models.fallback.length).toBeGreaterThan(0);
    expect(config.llm.provider).toBe("sakura");
  });

  test("開発用の factory.dev.toml は検証を通り、Google AI Studio と別のデータベースを使う", () => {
    const dev = loadConfig(resolve(import.meta.dirname, "../factory.dev.toml"));
    const prod = loadConfig(resolve(import.meta.dirname, "../factory.toml"));
    expect(dev.llm.provider).toBe("google-ai-studio");
    expect(dev.storage.database_path).not.toBe(prod.storage.database_path);
    expect(dev.storage.trace_dir).not.toBe(prod.storage.trace_dir);
    expect(dev.storage.eval_dir).not.toBe(prod.storage.eval_dir);
    // 原則 III: 実装役と検査役は別系統
    expect(dev.models.verifier).not.toBe(dev.models.implementer);
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

describe("parseConfig: [staging]（010）", () => {
  test("省略すると既定値が入り、デプロイは止まっている", () => {
    expect(parseConfig(MINIMAL, BASE_DIR).staging).toEqual({
      repo: "",
      project: "sakura-staging",
      image_name: "sakura-staging-app",
      port: 3100,
      health_path: "/healthz",
      health_timeout_seconds: 60,
      health_interval_seconds: 2,
      health_successes: 3,
      build_timeout_seconds: 600,
      keep_images: 5,
      public_url: "",
    });
  });

  test("値を指定できる", () => {
    const config = parseConfig(
      `${MINIMAL}\n[staging]\nrepo = "Coxless/factory-sandbox"\nport = 3199\npublic_url = "https://staging.example.jp"\nkeep_images = 2\n`,
      BASE_DIR,
    );
    expect(config.staging.repo).toBe("Coxless/factory-sandbox");
    expect(config.staging.port).toBe(3199);
    expect(config.staging.public_url).toBe("https://staging.example.jp");
    expect(config.staging.keep_images).toBe(2);
  });

  test.each([
    ['repo = "a"', "/staging/repo"],
    ['project = "Bad Name"', "/staging/project"],
    ['image_name = "x:tag"', "/staging/image_name"],
    ["port = 80", "/staging/port"],
    ['health_path = "healthz"', "/staging/health_path"],
    ["health_timeout_seconds = 0", "/staging/health_timeout_seconds"],
    ["health_successes = 21", "/staging/health_successes"],
    ["keep_images = 1", "/staging/keep_images"],
    ['public_url = "ftp://x"', "/staging/public_url"],
    ["build_timeout_seconds = 29", "/staging/build_timeout_seconds"],
    ["health_interval_seconds = 61", "/staging/health_interval_seconds"],
    ['compose_file = "x.yaml"', "/staging/compose_file"],
  ])("不正な値 %s はエラー", (line, path) => {
    expect(issuesOf(`${MINIMAL}\n[staging]\n${line}\n`).map((i) => i.path)).toEqual([path]);
  });
});
