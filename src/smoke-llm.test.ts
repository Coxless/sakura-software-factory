import { describe, expect, test } from "vitest";
import { parseConfig } from "./config.ts";
import { createLlmModels } from "./llm/provider.ts";
import { createTestGateDeps, type FakeResponse, TEST_API_KEY } from "./llm/testing.ts";
import { EXIT_ERROR, EXIT_FAILED, EXIT_PASSED, runSmokeCli } from "./smoke-llm.ts";

const PASSING: FakeResponse[] = [
  { text: "pong", usage: { input: 30, output: 1 } },
  { toolCall: { name: "get_weather", args: { city: "東京" } }, usage: { input: 80, output: 12 } },
  { text: "晴れです", usage: { input: 120, output: 6 } },
];

function harness(responses: FakeResponse[] = PASSING) {
  const setup = createTestGateDeps({ responses });
  const out: string[] = [];
  const err: string[] = [];
  let depsCreated = false;
  const io = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    loadConfig: () => setup.deps.config,
    createDeps: () => {
      depsCreated = true;
      return { deps: setup.deps, close: () => {} };
    },
  };
  const run = (argv: string[], env: NodeJS.ProcessEnv = { SAKURA_AI_API_KEY: TEST_API_KEY }) =>
    runSmokeCli(argv, env, io);
  return {
    setup,
    run,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    depsCreated: () => depsCreated,
  };
}

describe("runSmokeCli", () => {
  test("APIキーがなければ LLM を呼ばずに 2 で終わり、環境変数の名前を示す（US1-4）", async () => {
    const h = harness();
    expect(await h.run([], {})).toBe(EXIT_ERROR);
    expect(h.stderr()).toContain("SAKURA_AI_API_KEY");
    expect(h.depsCreated()).toBe(false);
    expect(h.setup.fake.requests).toHaveLength(0);
    h.setup.close();
  });

  test.each([
    [["--no-stream"]],
    [["--raw", "--compat", "supportsStore=true"]],
    [["--role", "boss"]],
    [["--compat", "noSuchFlag=true"]],
    [["--unknown"]],
  ])("引数の誤り %j は LLM を呼ばずに 2", async (argv) => {
    const h = harness();
    expect(await h.run(argv)).toBe(EXIT_ERROR);
    expect(h.setup.fake.requests).toHaveLength(0);
    h.setup.close();
  });

  test("全部合格なら 0 で、表に PASS と requests が出る", async () => {
    const h = harness();
    expect(await h.run([])).toBe(EXIT_PASSED);
    expect(h.stdout()).toContain("model: impl-model  mode: pi");
    expect(h.stdout()).toContain("[PASS] b ツール呼び出しが構造化されて返る");
    expect(h.stdout()).toContain("requests: 3");
    h.setup.close();
  });

  test("不合格があれば 1 で、FAIL とモデルの出力が出る（US1-3）", async () => {
    const h = harness([
      { text: "pong", usage: { input: 1, output: 1 } },
      { text: "<tool_call>get_weather</tool_call>", usage: { input: 1, output: 1 } },
    ]);
    expect(await h.run(["--", "--raw"])).toBe(EXIT_FAILED);
    expect(h.stdout()).toContain("[FAIL] e");
    expect(h.stdout()).toContain("<tool_call>get_weather</tool_call>");
    h.setup.close();
  });

  test("--json は SmokeReport の JSON を出す", async () => {
    const h = harness();
    expect(await h.run(["--json", "--compat", "supportsUsageInStreaming=true"])).toBe(EXIT_PASSED);
    const report = JSON.parse(h.stdout());
    expect(report).toMatchObject({ mode: "pi", requests: 3, passed: true });
    expect(report.compat.supportsUsageInStreaming).toBe(true);
    h.setup.close();
  });

  test("恒久的な HTTP エラーは 2 で、それまでの requests を出す", async () => {
    const h = harness([{ httpError: 401, body: '{"error":{"message":"invalid api key"}}' }]);
    expect(await h.run([])).toBe(EXIT_ERROR);
    expect(h.stderr()).toContain("401");
    expect(h.stderr()).toContain("requests: 1");
    h.setup.close();
  });
});

describe("runSmokeCli（開発用の Google AI Studio）", () => {
  const devConfig = () =>
    parseConfig(
      `
[llm]
provider = "google-ai-studio"
base_url = "https://generativelanguage.googleapis.com/v1beta/openai"
[models]
planner = "impl-model"
implementer = "impl-model"
verifier = "verify-model"
fallback = "fallback-model"
[budget]
monthly_requests = 100
per_job_requests = 10
[github]
allowed_users = ["tester"]
`,
      "/tmp",
    );

  test("APIキーは GEMINI_API_KEY を見る。SAKURA_AI_API_KEY だけでは LLM を呼ばずに 2", async () => {
    const err: string[] = [];
    const code = await runSmokeCli(
      [],
      { SAKURA_AI_API_KEY: TEST_API_KEY },
      {
        stdout: () => {},
        stderr: (text) => err.push(text),
        loadConfig: devConfig,
        createDeps: () => {
          throw new Error("呼ばれてはいけない");
        },
      },
    );
    expect(code).toBe(EXIT_ERROR);
    expect(err.join("")).toContain("GEMINI_API_KEY");
  });

  test("GEMINI_API_KEY があれば実行し、表に provider が出る", async () => {
    const setup = createTestGateDeps({ responses: PASSING });
    const config = devConfig();
    const out: string[] = [];
    const code = await runSmokeCli(
      [],
      { GEMINI_API_KEY: TEST_API_KEY },
      {
        stdout: (text) => out.push(text),
        stderr: () => {},
        loadConfig: () => config,
        createDeps: () => ({
          deps: { ...setup.deps, config, models: createLlmModels(config) },
          close: () => {},
        }),
      },
    );
    expect(code).toBe(EXIT_PASSED);
    expect(out.join("")).toContain("provider: google-ai-studio  model: impl-model  mode: pi");
    expect(setup.fake.requests[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    setup.close();
  });
});
