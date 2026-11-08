import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/** ジョブの状態（docs/design/03 3章）。遷移のルールは 007 の pipeline/state.ts で決める */
export const JOB_STATUSES = [
  "queued",
  "planning",
  "implementing",
  "testing",
  "judging",
  "pr_opened",
  "ci_waiting",
  "merged",
  "deploying",
  "deployed",
  "rolled_back",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_JOB_STATUSES = [
  "deployed",
  "rolled_back",
  "failed",
] as const satisfies readonly JobStatus[];

export const JOB_EVENT_TYPES = ["state_changed", "note", "error"] as const;
export const LLM_ROLES = ["planner", "implementer", "verifier"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];
export const LLM_CALL_STATUSES = ["ok", "error"] as const;
export const DEPLOYMENT_STATUSES = ["running", "succeeded", "failed"] as const;

/** `column IN ('a', 'b', ...)` の CHECK 用。値はこのファイルの定数だけなので埋め込んでよい */
function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  const list = values.map((value) => `'${value}'`).join(", ");
  return sql`${column} IN (${sql.raw(list)})`;
}

// 時刻の列はすべて UTC の Unix ミリ秒

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repo: text("repo").notNull(),
    issue_number: integer("issue_number").notNull(),
    trigger_comment_id: integer("trigger_comment_id").notNull(),
    requested_by: text("requested_by").notNull(),
    instruction: text("instruction").notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    judge_retries: integer("judge_retries").notNull().default(0),
    ci_retries: integer("ci_retries").notNull().default(0),
    branch: text("branch"),
    pr_number: integer("pr_number"),
    failure_reason: text("failure_reason"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    started_at: integer("started_at"),
    finished_at: integer("finished_at"),
  },
  (t) => [
    unique("jobs_repo_trigger_comment_unique").on(t.repo, t.trigger_comment_id),
    index("jobs_status_created_at_idx").on(t.status, t.created_at),
    check("jobs_status_check", oneOf(t.status, JOB_STATUSES)),
  ],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    job_id: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    type: text("type", { enum: JOB_EVENT_TYPES }).notNull(),
    from_status: text("from_status", { enum: JOB_STATUSES }),
    to_status: text("to_status", { enum: JOB_STATUSES }),
    /** JSON 文字列 */
    detail: text("detail"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("job_events_job_id_id_idx").on(t.job_id, t.id),
    check("job_events_type_check", oneOf(t.type, JOB_EVENT_TYPES)),
  ],
);

export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** スモークテスト・回帰評価などジョブに属さない呼び出しは NULL */
    job_id: integer("job_id").references(() => jobs.id),
    /** 工程は今後増えるので CHECK は付けない */
    phase: text("phase").notNull(),
    role: text("role", { enum: LLM_ROLES }).notNull(),
    model: text("model").notNull(),
    attempt: integer("attempt").notNull(),
    input_tokens: integer("input_tokens"),
    output_tokens: integer("output_tokens"),
    latency_ms: integer("latency_ms").notNull(),
    status: text("status", { enum: LLM_CALL_STATUSES }).notNull(),
    /** 秘密情報はマスク済みの内容を入れる */
    error: text("error"),
    /** 呼び出しの開始時刻。月の集計はこの列で行う */
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("llm_calls_created_at_idx").on(t.created_at),
    index("llm_calls_job_id_idx").on(t.job_id),
    check("llm_calls_role_check", oneOf(t.role, LLM_ROLES)),
    check("llm_calls_status_check", oneOf(t.status, LLM_CALL_STATUSES)),
    check("llm_calls_attempt_check", sql`${t.attempt} >= 1`),
    check("llm_calls_latency_check", sql`${t.latency_ms} >= 0`),
  ],
);

export const deployments = sqliteTable(
  "deployments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 人間が直接 main に push した場合は NULL */
    job_id: integer("job_id").references(() => jobs.id),
    commit_sha: text("commit_sha").notNull(),
    image_tag: text("image_tag").notNull(),
    status: text("status", { enum: DEPLOYMENT_STATUSES }).notNull(),
    rolled_back: integer("rolled_back", { mode: "boolean" }).notNull().default(false),
    rolled_back_to: text("rolled_back_to"),
    created_at: integer("created_at").notNull(),
    finished_at: integer("finished_at"),
  },
  (t) => [
    index("deployments_status_created_at_idx").on(t.status, t.created_at),
    check("deployments_status_check", oneOf(t.status, DEPLOYMENT_STATUSES)),
  ],
);

/** 月ごとの予算の記録。上限の正は factory.toml、消費件数は llm_calls から数える */
export const budget = sqliteTable(
  "budget",
  {
    /** YYYY-MM（設定のタイムゾーンで決める） */
    month: text("month").primaryKey(),
    /** その月に適用した月の上限（設定値の写し） */
    monthly_limit: integer("monthly_limit").notNull(),
    /** 新しいジョブの受付を止めた時刻。止めていなければ NULL */
    intake_stopped_at: integer("intake_stopped_at"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [check("budget_monthly_limit_check", sql`${t.monthly_limit} >= 1`)],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
export type LlmCall = typeof llmCalls.$inferSelect;
export type NewLlmCall = typeof llmCalls.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type Budget = typeof budget.$inferSelect;
export type NewBudget = typeof budget.$inferInsert;
