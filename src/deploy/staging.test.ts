import { describe, expect, test, vi } from "vitest";
import { testConfig } from "../llm/testing.ts";
import { createDockerStaging, DeployStepError, dockerEnv, imageTagFor } from "./staging.ts";

describe("staging（Docker を使わない）", () => {
  test("子プロセスの環境は PATH・HOME・DOCKER_* と渡したものだけ（SC-007）", () => {
    vi.stubEnv("SAKURA_AI_API_KEY", "sk-secret");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "whsec");
    vi.stubEnv("DOCKER_HOST", "unix:///run/docker.sock");
    const env = dockerEnv({ STAGING_IMAGE: "app:1" });
    vi.unstubAllEnvs();
    expect(Object.keys(env).sort()).toEqual(
      ["DOCKER_HOST", "STAGING_IMAGE", ...(process.env.HOME ? ["HOME"] : []), "PATH"].sort(),
    );
    expect(JSON.stringify(env)).not.toContain("sk-secret");
  });

  test("build・up・down の引数と、失敗の DeployStepError", async () => {
    const config = testConfig({ staging: { project: "proj", port: 3101 } }).staging;
    const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
    let exitCode = 0;
    const staging = createDockerStaging(config, {
      composeFile: "/c.yaml",
      run: async (args, options) => {
        calls.push({ args, env: options.env });
        return {
          exitCode,
          stdout: "",
          stderr: "boom ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          timedOut: false,
        };
      },
    });
    const image = imageTagFor(config, "a".repeat(40));
    expect(image).toBe("sakura-staging-app:aaaaaaaaaaaa");
    await staging.build({ dir: "/w", image });
    await staging.up({ image });
    await staging.down({});
    expect(calls.map((c) => c.args)).toEqual([
      ["build", "--label", "sakura-factory.staging=1", "-t", image, "/w"],
      [
        "compose",
        "-p",
        "proj",
        "-f",
        "/c.yaml",
        "up",
        "-d",
        "--remove-orphans",
        "--force-recreate",
      ],
      ["compose", "-p", "proj", "-f", "/c.yaml", "down", "--remove-orphans"],
    ]);
    expect(calls[1]?.env).toMatchObject({ STAGING_IMAGE: image, STAGING_PORT: "3101" });
    exitCode = 1;
    const error = await staging.up({ image }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeployStepError);
    expect((error as Error).message).toContain("ステージングの入れ替え（終了コード 1）: boom");
    expect((error as Error).message).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
