/**
 * ステージングの Docker の操作（010 research R4・R5、contracts/staging.md）。
 * ビルド・compose の入れ替え・止める・イメージの有無と片付けだけを持ち、何をいつ呼ぶかは runner.ts が決める。
 * docker・compose の子プロセスの環境は絞り、ファクトリーの秘密情報を渡さない（SC-007）
 */
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { FactoryConfig } from "../config.ts";
import { maskSecrets } from "../trace/mask.ts";

export type StagingConfig = FactoryConfig["staging"];

/** ステージングの compose の定義（ファクトリーのリポジトリに固定。research R13） */
export const STAGING_COMPOSE_FILE = fileURLToPath(
  new URL("../../deploy/staging/compose.yaml", import.meta.url),
);

/** ファクトリーが作ったステージングのイメージ・コンテナの印 */
export const STAGING_LABEL = "sakura-factory.staging=1";

/** docker・compose の操作が失敗した。message は stderr の末尾（伏せ字済み） */
export class DeployStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployStepError";
  }
}

/** <image_name>:<commit の先頭 12 文字> */
export function imageTagFor(config: Pick<StagingConfig, "image_name">, sha: string): string {
  return `${config.image_name}:${sha.slice(0, 12)}`;
}

/** ヘルスチェックの URL（ループバックに公開したポート） */
export function healthUrlFor(config: Pick<StagingConfig, "port" | "health_path">): string {
  return `http://127.0.0.1:${config.port}${config.health_path}`;
}

export interface StagingRuntime {
  /** dir の Dockerfile で image を作る。失敗は DeployStepError */
  build(req: { dir: string; image: string; signal?: AbortSignal }): Promise<void>;
  /** compose で image に入れ替える。失敗は DeployStepError */
  up(req: { image: string; signal?: AbortSignal }): Promise<void>;
  /** compose で止める。失敗は DeployStepError */
  down(req: { signal?: AbortSignal }): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  /** 消せなかったものは無視して、消したものを返す */
  removeImages(images: readonly string[]): Promise<string[]>;
}

const MAX_ERROR_CHARS = 2000;
/** compose の操作（up・down）の時間の上限 */
const COMPOSE_TIMEOUT_MS = 180_000;
/** inspect・rm の時間の上限 */
const SHORT_TIMEOUT_MS = 30_000;

/** 子プロセスに渡す環境: PATH・HOME・DOCKER_* と、渡したものだけ（research R4） */
export function dockerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "PATH" || key === "HOME" || key.startsWith("DOCKER_")) env[key] = value;
  }
  return { ...env, ...extra };
}

function tail(text: string): string {
  const trimmed = text.trim();
  return maskSecrets(
    trimmed.length <= MAX_ERROR_CHARS ? trimmed : `…${trimmed.slice(-MAX_ERROR_CHARS)}`,
  );
}

type Runner = (
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

const defaultRunner: Runner = async (args, options) => {
  const result = await execa("docker", args, {
    reject: false,
    env: options.env,
    extendEnv: false,
    stdin: "ignore",
    timeout: options.timeoutMs,
    forceKillAfterDelay: 5000,
    ...(options.signal ? { cancelSignal: options.signal } : {}),
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    timedOut: result.timedOut,
  };
};

/** 本物の StagingRuntime（docker CLI と docker compose） */
export function createDockerStaging(
  config: StagingConfig,
  options: { composeFile?: string; run?: Runner } = {},
): StagingRuntime {
  const run = options.run ?? defaultRunner;
  const composeFile = options.composeFile ?? STAGING_COMPOSE_FILE;
  const compose = (image: string) => ({
    args: ["compose", "-p", config.project, "-f", composeFile],
    env: dockerEnv({ STAGING_IMAGE: image, STAGING_PORT: String(config.port) }),
  });

  async function must(
    label: string,
    args: readonly string[],
    env: Record<string, string>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new DeployStepError(`${label}: 中断しました`);
    const result = await run(args, { env, timeoutMs, ...(signal ? { signal } : {}) });
    if (signal?.aborted) throw new DeployStepError(`${label}: 中断しました`);
    if (result.timedOut) {
      throw new DeployStepError(`${label}: ${Math.round(timeoutMs / 1000)} 秒で打ち切りました`);
    }
    if (result.exitCode !== 0) {
      throw new DeployStepError(
        `${label}（終了コード ${result.exitCode}）: ${tail(result.stderr)}`,
      );
    }
  }

  return {
    async build({ dir, image, signal }) {
      await must(
        "イメージのビルド",
        ["build", "--label", STAGING_LABEL, "-t", image, dir],
        dockerEnv(),
        config.build_timeout_seconds * 1000,
        signal,
      );
    },
    async up({ image, signal }) {
      const c = compose(image);
      await must(
        "ステージングの入れ替え",
        [...c.args, "up", "-d", "--remove-orphans", "--force-recreate"],
        c.env,
        COMPOSE_TIMEOUT_MS,
        signal,
      );
    },
    async down({ signal }) {
      // down でも compose の定義の変数を解決するので、仮のイメージの名前を渡す
      const c = compose(`${config.image_name}:down`);
      await must(
        "ステージングの停止",
        [...c.args, "down", "--remove-orphans"],
        c.env,
        COMPOSE_TIMEOUT_MS,
        signal,
      );
    },
    async imageExists(image) {
      const result = await run(["image", "inspect", "--format", "{{.Id}}", image], {
        env: dockerEnv(),
        timeoutMs: SHORT_TIMEOUT_MS,
      });
      return result.exitCode === 0;
    },
    async removeImages(images) {
      const removed: string[] = [];
      for (const image of images) {
        const result = await run(["image", "rm", image], {
          env: dockerEnv(),
          timeoutMs: SHORT_TIMEOUT_MS,
        });
        if (result.exitCode === 0) removed.push(image);
      }
      return removed;
    },
  };
}
