/**
 * 評価のケースの作業ディレクトリと作業場の用意（012 research R2・R3）。
 * 対象のプロジェクトを一時ディレクトリに複製 → setup/ を重ねる → git の初期コミット（diff の基準）→ 依存のインストール → 作業場。
 * 隠しのファイル（hidden/）は工程が終わるまで置かない。
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { FactoryConfig } from "../config.ts";
import { type Workspace, workspaceFromSandbox } from "../harness/workspace.ts";
import { type DiffSource, gitDiffSource, listGitFiles } from "../pipeline/diff.ts";
import { createSandbox, installDependencies, type Sandbox } from "../sandbox/docker.ts";
import type { EvalCase } from "./cases.ts";

export interface PreparedCase {
  workspace: Workspace;
  /** ホストの作業ディレクトリ（git の作業ツリー） */
  workdir: string;
  /** 既定は git。テストでは偽物 */
  diff?: DiffSource;
  listFiles?: (workdir: string) => Promise<string[]>;
  /** hidden/ を作業ディレクトリに上書きで置く（同名のファイルは上書き） */
  placeHidden(): Promise<void>;
  /** solution/ を重ねる（自己確認用） */
  applySolution(): Promise<void>;
  /** 作業場を片付け、一時ディレクトリを消す */
  close(): Promise<void>;
}

export type PrepareCase = (
  evalCase: EvalCase,
  config: FactoryConfig,
  jobId: number,
) => Promise<PreparedCase>;

/** 初期コミットは固定の作者で、ホストの git の設定・フック・署名を使わない */
const GIT = [
  "-c",
  "user.name=factory-eval",
  "-c",
  "user.email=eval@invalid",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
];

/** 本物の用意（Docker を使う） */
export const prepareCase: PrepareCase = async (evalCase, config, jobId) => {
  const root = mkdtempSync(join(tmpdir(), `factory-eval-${evalCase.id}-`));
  const workdir = join(root, "repo");
  let sandbox: Sandbox | undefined;
  try {
    cpSync(evalCase.projectDir, workdir, { recursive: true });
    if (evalCase.setupDir) cpSync(evalCase.setupDir, workdir, { recursive: true, force: true });
    await execa("git", ["init", "-q"], { cwd: workdir });
    await execa("git", ["add", "-A"], { cwd: workdir });
    await execa("git", [...GIT, "commit", "-q", "--no-verify", "-m", "eval-base"], {
      cwd: workdir,
    });
    if (evalCase.install) {
      const installed = await installDependencies({
        jobId,
        workspace: workdir,
        sandbox: config.sandbox,
        command: ["sh", "-c", evalCase.install],
      });
      if (installed.exitCode !== 0) {
        throw new Error(
          `依存のインストールに失敗しました（終了コード ${installed.exitCode}）:\n${new TextDecoder().decode(installed.stderr).slice(-2000)}`,
        );
      }
    }
    sandbox = await createSandbox({ jobId, workspace: workdir, sandbox: config.sandbox });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const created = sandbox;
  return {
    workspace: workspaceFromSandbox(created, config),
    workdir,
    diff: gitDiffSource,
    listFiles: listGitFiles,
    placeHidden: async () => {
      if (evalCase.hiddenDir) cpSync(evalCase.hiddenDir, workdir, { recursive: true, force: true });
    },
    applySolution: async () => {
      cpSync(evalCase.solutionDir, workdir, { recursive: true, force: true });
    },
    close: async () => {
      try {
        await created.destroy();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
};
