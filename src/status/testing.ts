import type { Db } from "../queue/db.ts";
import {
  agentRuns,
  budget,
  deployments,
  jobEvents,
  jobs,
  llmCalls,
  type NewAgentRun,
  type NewDeployment,
  type NewJob,
  type NewLlmCall,
} from "../queue/schema.ts";

/** テスト用: 状況ページの集計に使う記録を入れる */
export function createSeeder(db: Db) {
  let comment = 0;
  let commit = 0;

  function job(fields: Partial<NewJob> = {}): number {
    comment += 1;
    const created = fields.created_at ?? 0;
    const row = db
      .insert(jobs)
      .values({
        repo: "owner/repo",
        issue_number: comment,
        trigger_comment_id: comment,
        requested_by: "someone",
        instruction: "依頼の本文",
        status: "queued",
        updated_at: created,
        ...fields,
        created_at: created,
      })
      .returning({ id: jobs.id })
      .get();
    return row.id;
  }

  function llmCall(fields: Partial<NewLlmCall> = {}): void {
    const status = fields.status ?? "ok";
    db.insert(llmCalls)
      .values({
        phase: "implement",
        role: "implementer",
        model: "model-a",
        attempt: 1,
        latency_ms: 10,
        status,
        error_kind: status === "ok" ? null : "transient",
        created_at: 0,
        ...fields,
      })
      .run();
  }

  function ciResult(
    jobId: number,
    attempt: number,
    conclusion: "success" | "failure",
    createdAt: number,
  ): void {
    db.insert(jobEvents)
      .values({
        job_id: jobId,
        type: "note",
        detail: JSON.stringify({
          kind: "ci_result",
          head_sha: "a",
          conclusion,
          failed: [],
          attempt,
        }),
        created_at: createdAt,
      })
      .run();
  }

  function run(fields: Partial<NewAgentRun> & { job_id: number }): void {
    db.insert(agentRuns)
      .values({
        phase: "implement",
        attempt: 1,
        model: "model-a",
        trace_path: "traces/x.jsonl",
        started_at: 0,
        ...fields,
      })
      .run();
  }

  function deployment(fields: Partial<NewDeployment> = {}): void {
    commit += 1;
    const sha = commit.toString(16).padStart(4, "0").padEnd(40, "0");
    db.insert(deployments)
      .values({
        repo: "owner/demo",
        commit_sha: sha,
        image_tag: `demo:${sha.slice(0, 12)}`,
        status: "succeeded",
        created_at: 0,
        ...fields,
      })
      .run();
  }

  function budgetRow(month: string, intakeStoppedAt: number | null): void {
    db.insert(budget)
      .values({
        month,
        monthly_limit: 3000,
        intake_stopped_at: intakeStoppedAt,
        created_at: 0,
      })
      .run();
  }

  return { job, llmCall, ciResult, run, deployment, budgetRow };
}
