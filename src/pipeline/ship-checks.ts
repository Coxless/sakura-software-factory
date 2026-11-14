/**
 * 出荷前チェック（008 research R3・R4、data-model.md）。commit を対象に6条件をすべて評価し、
 * push してよいか（秘密情報・CI の定義の変更）を決める。gitleaks は GitHub に依存しないので pipeline/ に置く。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { execa } from "execa";
import type { FactoryConfig, WorkType } from "../config.ts";
import { maskSecrets } from "../trace/mask.ts";

/** 6つの条件の名前（評価と表示の順） */
export const CONDITION_NAMES = [
  "verdict",
  "diff_size",
  "forbidden_paths",
  "secrets",
  "skip_label",
  "work_type",
] as const;
export type ConditionName = (typeof CONDITION_NAMES)[number];

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
}

export type SecretScan =
  | { status: "clean" }
  | { status: "found"; findings: SecretFinding[] }
  | { status: "unavailable"; error: string };

export interface ForbiddenMatch {
  path: string;
  pattern: string;
}

/** 条件1つの結果。value の形は data-model.md の表 */
export type Condition =
  | { name: "verdict"; met: boolean; value: "pass" | "fail" }
  | { name: "diff_size"; met: boolean; value: { lines: number; max: number } }
  | { name: "forbidden_paths"; met: boolean; value: { matched: ForbiddenMatch[] } }
  | { name: "secrets"; met: boolean; value: SecretScan }
  | {
      name: "skip_label";
      met: boolean;
      value: { label: string; present: boolean } | { label: string; error: string };
    }
  | {
      name: "work_type";
      met: boolean;
      value: { work_type: string | null; allowed: readonly string[] };
    };

/** push しない理由 */
export type ShipBlocker = "secret_detected" | "unshippable_change";

const WORKFLOWS_PREFIX = ".github/workflows/";

export interface ShipCheckInput {
  config: FactoryConfig["auto_merge"];
  /** 005 が passed を返した（検査役の合格） */
  verdictPassed: boolean;
  /** 計画の作業の種類。計画がなければ undefined */
  workType: WorkType | undefined;
  /** commit の変更（名前の変更は両方のパス）と行数 */
  changes: { paths: readonly string[]; insertions: number; deletions: number };
  secrets: SecretScan;
  /** PR を作る直前に取り直した Issue のラベル。取れなければ error */
  labels: { names: readonly string[] } | { error: string };
}

export interface ShipCheckResult {
  conditions: Condition[];
  /** 満たさなかった条件（6条件の順） */
  unmet: ConditionName[];
  blocker: ShipBlocker | null;
}

/** 6条件をすべて評価し、push してよいかを決める（FR-002・FR-004・FR-005）。純粋関数 */
export function evaluateShipChecks(input: ShipCheckInput): ShipCheckResult {
  const { config } = input;
  const lines = input.changes.insertions + input.changes.deletions;
  const matched: ForbiddenMatch[] = [];
  for (const path of input.changes.paths) {
    const pattern = config.forbidden_paths.find((p) => posix.matchesGlob(path, p));
    if (pattern !== undefined) matched.push({ path, pattern });
  }
  const workflowChanged = input.changes.paths.some((path) => path.startsWith(WORKFLOWS_PREFIX));
  const skipLabel = config.skip_label;
  const labelValue =
    "error" in input.labels
      ? { label: skipLabel, error: input.labels.error }
      : {
          label: skipLabel,
          present: input.labels.names.some((n) => n.toLowerCase() === skipLabel.toLowerCase()),
        };
  const workType = input.workType ?? null;

  const conditions: Condition[] = [
    {
      name: "verdict",
      met: input.verdictPassed,
      value: input.verdictPassed ? "pass" : "fail",
    },
    {
      name: "diff_size",
      met: lines <= config.max_diff_lines,
      value: { lines, max: config.max_diff_lines },
    },
    {
      name: "forbidden_paths",
      // CI の定義は設定の禁止パスから外しても push しない（下の blocker）。表示でも満たさない側にする
      met: matched.length === 0 && !workflowChanged,
      value: {
        matched:
          workflowChanged && matched.length === 0
            ? input.changes.paths
                .filter((p) => p.startsWith(WORKFLOWS_PREFIX))
                .map((path) => ({ path, pattern: `${WORKFLOWS_PREFIX}**` }))
            : matched,
      },
    },
    { name: "secrets", met: input.secrets.status === "clean", value: input.secrets },
    { name: "skip_label", met: "present" in labelValue && !labelValue.present, value: labelValue },
    {
      name: "work_type",
      met: workType !== null && config.allowed_work_types.includes(workType),
      value: { work_type: workType, allowed: config.allowed_work_types },
    },
  ];
  const unmet = conditions.filter((c) => !c.met).map((c) => c.name);
  const blocker: ShipBlocker | null =
    input.secrets.status !== "clean"
      ? "secret_detected"
      : workflowChanged
        ? "unshippable_change"
        : null;
  return { conditions, unmet, blocker };
}

/** diff の追加行のうち gitleaks:allow を含むもの（research R4。インラインの許可を無効にするフラグがないため） */
export function findInlineAllows(diffText: string): { file: string; line: number }[] {
  const found: { file: string; line: number }[] = [];
  let file = "";
  let inHunk = false;
  let line = 0;
  for (const text of diffText.split("\n")) {
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      file = "";
      continue;
    }
    if (!inHunk) {
      if (text.startsWith("+++ ")) {
        const target = text.slice(4);
        file = target.startsWith("b/") ? target.slice(2) : target;
      }
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        inHunk = true;
        line = Number(hunk[1]);
      }
      continue;
    }
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith("+")) {
      if (text.includes("gitleaks:allow")) found.push({ file, line });
      line += 1;
    } else if (text.startsWith(" ")) {
      line += 1;
    }
  }
  return found;
}

const DEFAULT_GITLEAKS_CONFIG = "[extend]\nuseDefault = true\n";

/** ホストの git の設定を使わない環境 */
function safeEnv(home: string): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function showFromBase(
  dir: string,
  base: string,
  path: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const result = await execa(
    "git",
    ["-C", dir, "-c", "core.hooksPath=/dev/null", "show", `${base}:${path}`],
    { env, extendEnv: false, reject: false, stripFinalNewline: false },
  );
  return result.exitCode === 0 ? String(result.stdout) : undefined;
}

/**
 * gitleaks で <base>..<head> の1つの commit を調べる（research R4）。設定と .gitleaksignore は基準のコミットのものを
 * 使い、作業ツリーの許可を効かせない（作業ディレクトリの bare の複製を走査する）。「見つからない」は、終了コード 0 かつ1つの commit を走査したことを
 * 確かめられたときだけ。それ以外はスキャンできなかった（unavailable）
 */
export async function scanSecrets(req: {
  dir: string;
  base: string;
  head: string;
  timeoutMs: number;
  signal?: AbortSignal;
  gitleaksPath?: string;
}): Promise<SecretScan> {
  const work = mkdtempSync(join(tmpdir(), "factory-gitleaks-"));
  try {
    const env = safeEnv(join(work, "home"));
    mkdirSync(join(work, "home"));
    mkdirSync(join(work, "ignore"));
    const configText =
      (await showFromBase(req.dir, req.base, ".gitleaks.toml", env)) ?? DEFAULT_GITLEAKS_CONFIG;
    writeFileSync(join(work, "gitleaks.toml"), configText);
    const ignore = await showFromBase(req.dir, req.base, ".gitleaksignore", env);
    if (ignore !== undefined) writeFileSync(join(work, "ignore", ".gitleaksignore"), ignore);
    const report = join(work, "report.json");
    // gitleaks は --gitleaks-ignore-path を渡しても、走査するディレクトリ直下の .gitleaksignore を読む。
    // 作業ツリーのない bare の複製を走査して、エージェントが足した .gitleaksignore を効かせない（research R4）
    const bare = join(work, "repo.git");
    const cloned = await execa(
      "git",
      ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--bare", "--no-local", req.dir, bare],
      { env, extendEnv: false, reject: false },
    );
    if (cloned.exitCode !== 0) {
      return {
        status: "unavailable",
        error: maskSecrets(`走査用の複製を作れません: ${lastLines(String(cloned.stderr ?? ""))}`),
      };
    }

    const result = await execa(
      req.gitleaksPath ?? "gitleaks",
      [
        "git",
        "--no-banner",
        "--no-color",
        "--redact",
        "--exit-code",
        "3",
        "--config",
        join(work, "gitleaks.toml"),
        "--gitleaks-ignore-path",
        join(work, "ignore"),
        "--log-opts",
        `${req.base}..${req.head}`,
        "--report-format",
        "json",
        "--report-path",
        report,
        bare,
      ],
      {
        env,
        extendEnv: false,
        reject: false,
        timeout: Math.max(1, req.timeoutMs),
        ...(req.signal ? { cancelSignal: req.signal } : {}),
      },
    );
    const stderr = String(result.stderr ?? "");
    if (result.timedOut) return { status: "unavailable", error: "時間の上限を過ぎました" };
    if (result.isCanceled) return { status: "unavailable", error: "中断しました" };
    if (result.exitCode === 3) {
      const raw = JSON.parse(readFileSync(report, "utf8")) as {
        File?: string;
        StartLine?: number;
        RuleID?: string;
      }[];
      return {
        status: "found",
        findings: raw.map((f) => ({
          file: f.File ?? "",
          line: f.StartLine ?? 0,
          rule: f.RuleID ?? "unknown",
        })),
      };
    }
    const scannedOne = /(^|\s)1 commits scanned/m.test(stderr);
    const errored = /\s(ERR|FTL)\s/.test(stderr);
    if (result.exitCode === 0 && scannedOne && !errored) return { status: "clean" };
    const reason =
      result.exitCode === undefined
        ? (result.shortMessage ?? "gitleaks を起動できません")
        : `終了コード ${result.exitCode}: ${lastLines(stderr)}`;
    return { status: "unavailable", error: maskSecrets(reason) };
  } catch (error) {
    return {
      status: "unavailable",
      error: maskSecrets(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function lastLines(text: string): string {
  const lines = text
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "");
  return lines.slice(-3).join(" / ").slice(0, 500) || "出力なし";
}
