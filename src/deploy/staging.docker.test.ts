/**
 * 本物の Docker と docker compose でステージングの入れ替え・ヘルスチェック・ロールバックを確かめる（010 quickstart.md 1章）。
 * 作業場のイメージを土台に小さなアプリを2つビルドするので、Docker Hub から取らない。
 * Docker・イメージ・compose がなければ理由を出して飛ばす（CI では FACTORY_SANDBOX_REQUIRED=1 で飛ばさない）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, describe, expect, test } from "vitest";
import { testConfig } from "../llm/testing.ts";
import { dockerSkipReason, reportSkip, TEST_IMAGE } from "../sandbox/testing.ts";
import { waitHealthy } from "./health.ts";
import { createDockerStaging, healthUrlFor } from "./staging.ts";

async function composeSkipReason(): Promise<string | undefined> {
  const docker = await dockerSkipReason();
  if (docker) return docker;
  const compose = await execa("docker", ["compose", "version"], { reject: false, timeout: 10_000 });
  return compose.exitCode === 0
    ? undefined
    : "docker compose がないため、ステージングのテストを飛ばします（docker-compose-v2 を入れてください）";
}

const skip = await composeSkipReason();
reportSkip(skip);

const PROJECT = "sakura-staging-test";
const PORT = 3199;
const IMAGES = ["sakura-staging-test-app:good", "sakura-staging-test-app:bad"];

/** /healthz が HEALTH_STATUS を返すアプリ */
function writeApp(dir: string, status: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "server.js"),
    `const http = require("node:http");
const status = Number(process.env.HEALTH_STATUS);
http.createServer((req, res) => {
  res.statusCode = req.url === "/healthz" ? status : 404;
  res.end(String(res.statusCode));
}).listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
`,
  );
  writeFileSync(
    join(dir, "Dockerfile"),
    `FROM ${TEST_IMAGE}
WORKDIR /app
COPY server.js .
ENV HEALTH_STATUS=${status}
CMD ["node", "server.js"]
`,
  );
}

describe.skipIf(skip)("ステージング（本物の Docker）", () => {
  const base = testConfig({
    staging: {
      project: PROJECT,
      port: PORT,
      image_name: "sakura-staging-test-app",
      health_timeout_seconds: 10,
      health_interval_seconds: 1,
      health_successes: 3,
    },
  });
  const staging = createDockerStaging(base.staging);
  const root = mkdtempSync(join(tmpdir(), "factory-staging-"));
  const check = () =>
    waitHealthy({
      url: healthUrlFor(base.staging),
      timeoutMs: base.staging.health_timeout_seconds * 1000,
      intervalMs: base.staging.health_interval_seconds * 1000,
      successes: base.staging.health_successes,
    });

  afterAll(async () => {
    await staging.down({}).catch(() => undefined);
    await staging.removeImages([...IMAGES, "sakura-staging-test-app:broken"]);
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  test("正常な版を出し、不健康な版で直前の版に戻す", async () => {
    writeApp(join(root, "good"), 200);
    writeApp(join(root, "bad"), 500);
    await staging.build({ dir: join(root, "good"), image: IMAGES[0] as string });
    await staging.build({ dir: join(root, "bad"), image: IMAGES[1] as string });
    expect(await staging.imageExists(IMAGES[0] as string)).toBe(true);

    await staging.up({ image: IMAGES[0] as string });
    expect((await check()).healthy).toBe(true);

    await staging.up({ image: IMAGES[1] as string });
    const bad = await check();
    expect(bad).toMatchObject({ healthy: false, last: "500" });

    await staging.up({ image: IMAGES[0] as string });
    expect((await check()).healthy).toBe(true);

    // 隔離の設定が効いている（非 root・読み取り専用・ループバックだけに公開）
    const inspect = await execa("docker", [
      "inspect",
      "--format",
      '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{(index (index .HostConfig.PortBindings "3000/tcp") 0).HostIp}}',
      `${PROJECT}-app-1`,
    ]);
    expect(inspect.stdout).toBe("65534:65534 true 127.0.0.1");
  }, 300_000);

  test("ビルドに失敗すると DeployStepError（stderr の末尾）", async () => {
    const dir = join(root, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), `FROM ${TEST_IMAGE}\nRUN exit 3\n`);
    await expect(staging.build({ dir, image: "sakura-staging-test-app:broken" })).rejects.toThrow(
      /イメージのビルド（終了コード \d+）/,
    );
  }, 120_000);
});
