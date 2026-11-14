/**
 * テスト専用: 評価のセットを一時ディレクトリに作る・偽の PrepareCase・結果の雛形。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { FactoryConfig } from "../config.ts";
import {
  createFakeDiffSource,
  createFakeWorkspace,
  type FakeBashBehavior,
  type FakeWorkspace,
} from "../pipeline/testing.ts";
import type { EvalCase } from "./cases.ts";
import type { PrepareCase, PreparedCase } from "./prepare.ts";
import { type CaseResult, type EvalRun, summarize } from "./result.ts";

export interface TestCaseSpec {
  id: string;
  /** case.toml の本文（省略時は既定の内容） */
  toml?: string;
  /** issue.md（省略時は「題\n本文」） */
  issue?: string | null;
  setup?: Record<string, string>;
  hidden?: Record<string, string>;
  /** null なら solution/ を作らない */
  solution?: Record<string, string> | null;
}

export const DEFAULT_CASE_TOML = `work_type = "bugfix"
project = "projects/demo"
check_commands = ["check-cmd"]

[grader]
commands = ["grade-cmd"]
`;

export const DEMO_PROJECT = { "src/a.ts": "export const a = 1;\n", "README.md": "# demo\n" };

function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** 一時ディレクトリにセットを作る。cleanup で消す */
export function writeTestSet(
  cases: TestCaseSpec[],
  project: Record<string, string> = DEMO_PROJECT,
  name = "evals",
) {
  const root = mkdtempSync(join(tmpdir(), "eval-set-"));
  const dir = join(root, name);
  writeFiles(join(dir, "projects/demo"), project);
  mkdirSync(join(dir, "cases"), { recursive: true });
  for (const spec of cases) {
    const caseDir = join(dir, "cases", spec.id);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "case.toml"), spec.toml ?? DEFAULT_CASE_TOML);
    if (spec.issue !== null) {
      writeFileSync(join(caseDir, "issue.md"), spec.issue ?? `${spec.id} を直す\n本文`);
    }
    if (spec.setup) writeFiles(join(caseDir, "setup"), spec.setup);
    if (spec.hidden) writeFiles(join(caseDir, "hidden"), spec.hidden);
    if (spec.solution !== null) {
      writeFiles(join(caseDir, "solution"), spec.solution ?? { "src/a.ts": "export const a = 2;\n" });
    }
  }
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readTree(dir: string | undefined): Record<string, string> {
  if (!dir) return {};
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return out;
}

export interface FakePrepareOptions {
  /**
   * Workspace.exec の応答。ケースと作業場のファイルを見て決める（工程内テストと合格条件の両方に使われる）。
   * 既定は終了コード 0
   */
  exec?: (command: string, ctx: { evalCase: EvalCase; files: Map<string, string> }) => FakeBashBehavior;
  /** このケースの用意で投げる */
  failFor?: (evalCase: EvalCase) => Error | undefined;
}

export interface FakePrepareLog {
  prepared: { caseId: string; jobId: number; workspace: FakeWorkspace }[];
  closed: string[];
  hiddenPlaced: string[];
}

/** プロジェクト＋setup の中身で偽の作業場を作る PrepareCase */
export function createFakePrepare(options: FakePrepareOptions = {}): {
  prepare: PrepareCase;
  log: FakePrepareLog;
} {
  const log: FakePrepareLog = { prepared: [], closed: [], hiddenPlaced: [] };
  const prepare: PrepareCase = async (evalCase: EvalCase, config: FactoryConfig, jobId: number) => {
    const failure = options.failFor?.(evalCase);
    if (failure) throw failure;
    const initial = { ...readTree(evalCase.projectDir), ...readTree(evalCase.setupDir) };
    // exec は作業場ができたあとに呼ばれるので、入れ物を通して作業場のファイルを見せる
    const holder: { workspace?: FakeWorkspace } = {};
    const workspace = createFakeWorkspace(initial, {
      config,
      exec: (command) =>
        options.exec?.(command, { evalCase, files: holder.workspace?.files ?? new Map() }) ?? {
          exitCode: 0,
        },
    });
    holder.workspace = workspace;
    log.prepared.push({ caseId: evalCase.id, jobId, workspace });
    const prepared: PreparedCase = {
      workspace,
      workdir: `/fake/${evalCase.id}`,
      diff: createFakeDiffSource(workspace, initial),
      listFiles: async () => [...workspace.files.keys()],
      placeHidden: async () => {
        log.hiddenPlaced.push(evalCase.id);
        for (const [path, content] of Object.entries(readTree(evalCase.hiddenDir))) {
          workspace.files.set(path, content);
        }
      },
      applySolution: async () => {
        for (const [path, content] of Object.entries(readTree(evalCase.solutionDir))) {
          workspace.files.set(path, content);
        }
      },
      close: async () => {
        log.closed.push(evalCase.id);
      },
    };
    return prepared;
  };
  return { prepare, log };
}

const MODELS = { planner: "p", implementer: "i", verifier: "v" };

/** 結果の雛形（比較・表示のテスト用） */
export function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "c1",
    caseHash: "sha256:x",
    workType: "bugfix",
    attempt: 1,
    status: "succeeded",
    reason: "",
    requests: 10,
    durationMs: 1000,
    ...overrides,
  };
}

export function evalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  const cases = overrides.cases ?? [caseResult()];
  const models = overrides.models ?? MODELS;
  return {
    version: 1,
    runId: "20261114T100000Z-evals",
    setName: "evals",
    startedAt: "2026-11-14T10:00:00.000Z",
    finishedAt: "2026-11-14T10:30:00.000Z",
    harness: { commit: "abc", dirty: false },
    provider: "google-ai-studio",
    models,
    options: { cases: null, repeat: 1, maxRequests: 100 },
    cases,
    summary: summarize(cases, models),
    ...overrides,
  };
}
