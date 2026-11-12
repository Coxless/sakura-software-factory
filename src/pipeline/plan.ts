/**
 * 計画役（005 US1、research R3）。ツールなしの1回呼び出しで計画を出させ、TypeBox で検証する（再要求は1回まで）。
 */
import Type, { type Static } from "typebox";
import { WORK_TYPES } from "../config.ts";
import {
  buildPlannerMessage,
  PLANNER_SYSTEM_PROMPT,
  type PlannerInput,
} from "../harness/prompts/planner.ts";
import { type OneShotDeps, type OneShotOutcome, runOneShot } from "./oneshot.ts";

export { WORK_TYPES, type WorkType } from "../config.ts";

const Text = Type.String({ minLength: 1 });

/** 計画役の出力（data-model.md 3章）。余分な項目は許す */
export const PlanSchema = Type.Object({
  summary: Text,
  steps: Type.Array(Text, { minItems: 1 }),
  acceptance_criteria: Type.Array(Text, { minItems: 1 }),
  work_type: Type.Enum([...WORK_TYPES]),
});

export type Plan = Static<typeof PlanSchema>;

/** 計画を実装役・検査役に渡す文章にする */
export function planToText(plan: Plan): string {
  const numbered = (items: readonly string[]) =>
    items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  return [
    "## 概要",
    plan.summary,
    "",
    "## 作業手順",
    numbered(plan.steps),
    "",
    "## 受け入れ条件",
    numbered(plan.acceptance_criteria),
    "",
    "## 作業の種類",
    plan.work_type,
  ].join("\n");
}

export interface MakePlanInput extends PlannerInput {
  jobId: number;
  signal?: AbortSignal;
  abortReason?: () => "timeout" | "aborted";
}

/** 計画を立てる。例外は投げない */
export function makePlan(deps: OneShotDeps, input: MakePlanInput): Promise<OneShotOutcome<Plan>> {
  const { config } = deps.gate;
  const message = buildPlannerMessage(input, {
    max_issue_chars: config.implementer.max_issue_chars,
    max_agents_md_chars: config.implementer.max_agents_md_chars,
    max_file_list_chars: config.pipeline.max_file_list_chars,
  });
  return runOneShot(deps, {
    jobId: input.jobId,
    phase: "plan",
    role: "planner",
    schema: PlanSchema,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    userMessage: message.text,
    truncated: message.truncated,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.abortReason ? { abortReason: input.abortReason } : {}),
  });
}
