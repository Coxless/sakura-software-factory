/**
 * 検査役（005 US3）。ツールなしの1回呼び出しで判定させ、TypeBox で検証する（再要求は1回まで。原則 III）。
 */
import Type, { type Static } from "typebox";
import {
  buildVerifierMessage,
  VERIFIER_SYSTEM_PROMPT,
  type VerifierInput,
} from "../harness/prompts/verifier.ts";
import { VERDICTS } from "../queue/schema.ts";
import { type OneShotDeps, type OneShotOutcome, runOneShot } from "./oneshot.ts";

/** 検査役の出力（data-model.md 3章）。余分な項目は許す */
export const VerdictSchema = Type.Object({
  verdict: Type.Enum([...VERDICTS]),
  reasons: Type.String({ minLength: 1 }),
  criteria: Type.Array(
    Type.Object({
      criterion: Type.String(),
      met: Type.Boolean(),
      note: Type.Optional(Type.String()),
    }),
  ),
  fixes: Type.Optional(Type.Array(Type.String())),
});

export type Verdict = Static<typeof VerdictSchema>;

export interface JudgeInput extends VerifierInput {
  jobId: number;
  signal?: AbortSignal;
  abortReason?: () => "timeout" | "aborted";
}

/** 判定する。合否は verdict の値だけで決める。例外は投げない */
export function judge(deps: OneShotDeps, input: JudgeInput): Promise<OneShotOutcome<Verdict>> {
  const { config } = deps.gate;
  const message = buildVerifierMessage(input, {
    max_issue_chars: config.implementer.max_issue_chars,
    max_plan_chars: config.implementer.max_plan_chars,
    max_diff_chars: config.pipeline.max_diff_chars,
    max_check_log_chars: config.pipeline.max_check_log_chars,
  });
  return runOneShot(deps, {
    jobId: input.jobId,
    phase: "judge",
    role: "verifier",
    schema: VerdictSchema,
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    userMessage: message.text,
    truncated: message.truncated,
    verdictOf: (value) => value.verdict,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.abortReason ? { abortReason: input.abortReason } : {}),
  });
}

/** 不合格の理由と直すべき点を、やり直しのフィードバックの本文にする */
export function verdictFeedback(verdict: Verdict): string {
  const unmet = verdict.criteria.filter((c) => !c.met);
  return [
    `理由: ${verdict.reasons}`,
    ...(unmet.length > 0
      ? [
          "満たしていない受け入れ条件:",
          ...unmet.map((c) => `- ${c.criterion}${c.note ? `（${c.note}）` : ""}`),
        ]
      : []),
    ...(verdict.fixes && verdict.fixes.length > 0
      ? ["直すべき点:", ...verdict.fixes.map((fix) => `- ${fix}`)]
      : []),
  ].join("\n");
}
