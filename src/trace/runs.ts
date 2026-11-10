/** agent_runs（ツールを使う工程の実行1回ごとの要約）の作成と更新。004 data-model.md 1章 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../queue/db.ts";
import { type AgentRunOutcome, agentRuns } from "../queue/schema.ts";

export interface AgentRunSummary {
  outcome: AgentRunOutcome;
  turns: number;
  requests: number;
  toolCalls: number;
  blockedCalls: number;
  compactions: number;
  steers: number;
  error?: string;
  finishedAt: number;
}

/**
 * 実行の行を作る（outcome は NULL）。attempt は同じジョブ・同じ工程の既存の行数 + 1。
 * LLM を使う工程の同時実行は1件（原則 VII）なので、数えてから入れる間に別の行は増えない。
 */
export function startAgentRun(
  db: Db,
  row: { jobId: number; phase: string; model: string; tracePath: string; startedAt: number },
): { id: number; attempt: number } {
  return db.transaction((tx) => {
    const [counted] = tx
      .select({ count: sql<number>`count(*)` })
      .from(agentRuns)
      .where(and(eq(agentRuns.job_id, row.jobId), eq(agentRuns.phase, row.phase)))
      .all();
    const attempt = (counted?.count ?? 0) + 1;
    const [inserted] = tx
      .insert(agentRuns)
      .values({
        job_id: row.jobId,
        phase: row.phase,
        attempt,
        model: row.model,
        trace_path: row.tracePath,
        started_at: row.startedAt,
      })
      .returning({ id: agentRuns.id })
      .all();
    if (!inserted) throw new Error("agent_runs の行を作れませんでした");
    return { id: inserted.id, attempt };
  });
}

/** 実行の終わり方と各回数を書く */
export function finishAgentRun(db: Db, id: number, summary: AgentRunSummary): void {
  db.update(agentRuns)
    .set({
      outcome: summary.outcome,
      turns: summary.turns,
      requests: summary.requests,
      tool_calls: summary.toolCalls,
      blocked_calls: summary.blockedCalls,
      compactions: summary.compactions,
      steers: summary.steers,
      error: summary.error ?? null,
      finished_at: summary.finishedAt,
    })
    .where(eq(agentRuns.id, id))
    .run();
}
