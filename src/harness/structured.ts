/**
 * 計画役・検査役の出力の取り出しと検証（005 research R2）。
 * さくらは response_format を無視するので、プロンプトで JSON を出させてこちらで検証する（原則 III）。
 * Pi に依存しない。
 */
import type { Static, TSchema } from "typebox";
import Value from "typebox/value";
import { describeSchemaErrors } from "../config.ts";

/** 文字列とエスケープを考慮して、start の `{` に対応する `}` の位置を返す。なければ -1 */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 出力から最初の JSON オブジェクトを取り出す（コードブロックの囲み・前後の説明文を許す） */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  try {
    const whole = JSON.parse(trimmed) as unknown;
    if (isObject(whole)) return whole;
  } catch {
    // 前後に説明文やコードブロックがある。下で探す
  }
  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    const end = matchingBrace(trimmed, start);
    if (end === -1) continue;
    try {
      const candidate = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      if (isObject(candidate)) return candidate;
    } catch {
      // 次の候補へ
    }
  }
  return undefined;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** スキーマで検証し、合わなければ「パス: 理由」の一覧を返す。余分な項目は許す（スキーマで禁じない） */
export function validate<S extends TSchema>(schema: S, value: unknown): Validation<Static<S>> {
  if (Value.Check(schema, value)) return { ok: true, value: value as Static<S> };
  const errors = describeSchemaErrors(schema, value).map(
    (issue) => `${issue.path === "" ? "/" : issue.path}: ${issue.message}`,
  );
  return { ok: false, errors: errors.length > 0 ? errors : ["/: 形が合いません"] };
}

/** 再要求の user メッセージ。errors が空なら JSON を取り出せなかったとき */
export function repairMessage(errors: readonly string[]): string {
  const problem =
    errors.length === 0
      ? "前回の出力から JSON オブジェクトを見つけられませんでした。"
      : `前回の出力は決められた形に合いませんでした。\n${errors.map((e) => `- ${e}`).join("\n")}`;
  return `${problem}\n指示した形の JSON オブジェクトだけを、説明文やコードブロックの囲みを付けずに返してください。`;
}
