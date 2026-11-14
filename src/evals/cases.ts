/**
 * 評価のセット（012 US1、contracts/case-format.md）: evals/cases/<id>/ を読み、形を検証し、内容のハッシュを付ける。
 * 誤りはケースの ID と理由を全部集めて EvalSetError で返す。LLM も作業場も使わない。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { describeSchemaErrors, WORK_TYPES, type WorkType } from "../config.ts";
import { parseIssueFile } from "../pipeline-dev.ts";

const NonEmpty = Type.String({ minLength: 1 });

const CaseFileSchema = Type.Object(
  {
    work_type: Type.Enum([...WORK_TYPES]),
    project: NonEmpty,
    instruction: Type.Optional(NonEmpty),
    install: Type.Optional(NonEmpty),
    check_commands: Type.Array(NonEmpty, { default: [] }),
    grader: Type.Object(
      {
        commands: Type.Array(NonEmpty, { minItems: 1 }),
        timeout_seconds: Type.Integer({ minimum: 10, maximum: 1800, default: 300 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
type CaseFile = Static<typeof CaseFileSchema>;

export const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface EvalCase {
  id: string;
  workType: WorkType;
  title: string;
  body: string;
  instruction?: string;
  /** 対象のプロジェクトの絶対パス */
  projectDir: string;
  install?: string;
  checkCommands: string[];
  grader: { commands: string[]; timeoutSeconds: number };
  setupDir?: string;
  hiddenDir?: string;
  solutionDir: string;
  /** sha256:<hex>。ケースのディレクトリとプロジェクトのファイルの相対パスと内容から */
  hash: string;
}

export interface EvalSet {
  /** セットのディレクトリ名（結果の setName） */
  name: string;
  dir: string;
  cases: EvalCase[];
}

export interface EvalSetIssue {
  caseId: string;
  message: string;
}

export class EvalSetError extends Error {
  readonly dir: string;
  readonly issues: EvalSetIssue[];
  constructor(dir: string, issues: EvalSetIssue[]) {
    super(
      `評価のセット（${dir}）に誤りがあります:\n${issues.map((i) => `- ${i.caseId}: ${i.message}`).join("\n")}`,
    );
    this.name = "EvalSetError";
    this.dir = dir;
    this.issues = issues;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** ディレクトリの下のファイル（相対パス順） */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

function hashDirs(dirs: readonly { label: string; dir: string }[]): string {
  const hash = createHash("sha256");
  for (const { label, dir } of dirs) {
    for (const file of listFiles(dir)) {
      hash.update(`${label}/${relative(dir, file)}\0`);
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

/** 1件のケースを読む。誤りは issues に足して undefined を返す */
function loadCase(setDir: string, id: string, issues: EvalSetIssue[]): EvalCase | undefined {
  const dir = join(setDir, "cases", id);
  const problems: string[] = [];
  if (!CASE_ID_PATTERN.test(id)) {
    problems.push("ID（ディレクトリ名）は英小文字・数字・ハイフンで、64文字以内にしてください");
  }
  const tomlPath = join(dir, "case.toml");
  let file: CaseFile | undefined;
  if (!existsSync(tomlPath)) {
    problems.push("case.toml がありません");
  } else {
    try {
      const raw = Value.Default(CaseFileSchema, parse(readFileSync(tomlPath, "utf8")));
      const errors = describeSchemaErrors(CaseFileSchema, raw);
      if (errors.length > 0) {
        for (const e of errors) problems.push(`case.toml ${e.path}: ${e.message}`);
      } else {
        file = raw as CaseFile;
      }
    } catch (error) {
      problems.push(
        `case.toml を読めません: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const issuePath = join(dir, "issue.md");
  let issue: { title: string; body: string } | undefined;
  if (!existsSync(issuePath)) {
    problems.push("issue.md がありません");
  } else {
    issue = parseIssueFile(readFileSync(issuePath, "utf8"));
    if (issue.title === "") problems.push("issue.md の1行目（タイトル）が空です");
  }
  const solutionDir = join(dir, "solution");
  if (!isDir(solutionDir)) problems.push("solution/（模範解答）がありません");
  const projectDir = file ? resolve(setDir, file.project) : undefined;
  if (file && projectDir && !isDir(projectDir)) {
    problems.push(`project のディレクトリがありません: ${file.project}`);
  }

  if (problems.length > 0 || !file || !issue || !projectDir) {
    for (const message of problems) issues.push({ caseId: id, message });
    return undefined;
  }
  const setupDir = join(dir, "setup");
  const hiddenDir = join(dir, "hidden");
  return {
    id,
    workType: file.work_type,
    title: issue.title,
    body: issue.body,
    ...(file.instruction ? { instruction: file.instruction } : {}),
    projectDir,
    ...(file.install ? { install: file.install } : {}),
    checkCommands: [...file.check_commands],
    grader: { commands: [...file.grader.commands], timeoutSeconds: file.grader.timeout_seconds },
    ...(isDir(setupDir) ? { setupDir } : {}),
    ...(isDir(hiddenDir) ? { hiddenDir } : {}),
    solutionDir,
    hash: hashDirs([
      { label: "case", dir },
      { label: "project", dir: projectDir },
    ]),
  };
}

/** 評価のセットを読む。only を渡すとそのケースだけ。誤りは EvalSetError */
export function loadEvalSet(dir: string, options: { only?: readonly string[] } = {}): EvalSet {
  const setDir = resolve(dir);
  const casesDir = join(setDir, "cases");
  if (!isDir(casesDir)) {
    throw new EvalSetError(setDir, [{ caseId: "-", message: "cases/ ディレクトリがありません" }]);
  }
  const ids = readdirSync(casesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const issues: EvalSetIssue[] = [];
  let selected = ids;
  if (options.only !== undefined) {
    const unknown = options.only.filter((id) => !ids.includes(id));
    for (const id of unknown) issues.push({ caseId: id, message: "そのケースはありません" });
    selected = ids.filter((id) => options.only?.includes(id));
  }
  const cases = selected
    .map((id) => loadCase(setDir, id, issues))
    .filter((c): c is EvalCase => c !== undefined);
  if (issues.length === 0 && cases.length === 0) {
    issues.push({ caseId: "-", message: "ケースが1件もありません" });
  }
  if (issues.length > 0) throw new EvalSetError(setDir, issues);
  return { name: basename(setDir), dir: setDir, cases };
}
