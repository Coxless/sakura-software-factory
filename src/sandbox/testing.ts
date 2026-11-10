import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { test } from "vitest";
import { DEFAULT_DENY_WRITE_PATHS } from "../config.ts";
import type { SandboxConfig } from "./options.ts";
import type { ToolsConfig } from "./tools.ts";

/** Docker を使うテストのイメージ */
export const TEST_IMAGE = process.env.FACTORY_SANDBOX_TEST_IMAGE ?? "factory-sandbox:latest";

/** Docker を使うテストの実行ユーザー。root で動かすときは 1000:1000 */
export function testUser(): string {
  if (process.env.FACTORY_SANDBOX_TEST_USER) return process.env.FACTORY_SANDBOX_TEST_USER;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return uid === 0 ? "1000:1000" : `${uid}:${gid}`;
}

let readiness: Promise<string | undefined> | undefined;

/**
 * Docker とテスト用イメージが使えるか。使えなければ飛ばす理由を返す（使えれば undefined）。
 * 結果はプロセス内でキャッシュする。
 */
export function dockerSkipReason(): Promise<string | undefined> {
  readiness ??= (async () => {
    const info = await execa("docker", ["info", "--format", "{{.ServerVersion}}"], {
      reject: false,
      timeout: 10_000,
    });
    if (info.exitCode !== 0) return "Docker デーモンに接続できないため、作業場のテストを飛ばします";
    const image = await execa("docker", ["image", "inspect", TEST_IMAGE], {
      reject: false,
      timeout: 10_000,
    });
    if (image.exitCode !== 0) {
      return `イメージ ${TEST_IMAGE} がないため、作業場のテストを飛ばします（pnpm run sandbox:build で作れます）`;
    }
    return undefined;
  })();
  return readiness;
}

/** 作業場のテストを飛ばすときに、理由を出力に残すテストを1つ足す（describe の外で呼ぶ） */
export function reportSkip(reason: string | undefined): void {
  test.runIf(reason !== undefined)("作業場のテストを飛ばした理由を出す", () => {
    process.stderr.write(`${reason}\n`);
  });
}

export function testSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    image: TEST_IMAGE,
    user: testUser(),
    cpus: 1,
    memory_mb: 512,
    pids_limit: 128,
    tmp_size_mb: 64,
    install_timeout_seconds: 60,
    ...overrides,
  };
}

export function testToolsConfig(overrides: Partial<ToolsConfig> = {}): ToolsConfig {
  return {
    bash_timeout_seconds: 10,
    bash_max_timeout_seconds: 20,
    read_max_lines: 100,
    max_output_chars: 20_000,
    deny_write_paths: [...DEFAULT_DENY_WRITE_PATHS],
    ...overrides,
  };
}

/**
 * 一時ディレクトリに git リポジトリ（README.md を1回 commit 済み）を作り、
 * 作業場の実行ユーザーが書けるように所有者を変える。
 */
export async function makeWorkspace(files: Record<string, string> = {}): Promise<{
  path: string;
  cleanup(): void;
}> {
  const path = mkdtempSync(join(tmpdir(), "factory-ws-"));
  writeFileSync(join(path, "README.md"), "# test\n");
  for (const [name, content] of Object.entries(files)) {
    const file = join(path, name);
    await execa("mkdir", ["-p", join(file, "..")]);
    writeFileSync(file, content);
  }
  const git = (...args: string[]) =>
    execa("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
      cwd: path,
    });
  await git("init", "--quiet");
  await git("add", "--all");
  await git("commit", "--quiet", "--message", "init");
  if (process.getuid?.() === 0) await execa("chown", ["-R", testUser(), path]);
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
