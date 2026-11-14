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

/** CI の結論（009 data-model.md 1章）。failed は「やり直しを待つ」 */
export const CI_STATUSES = ["pending", "passed", "failed"] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export const JOB_EVENT_TYPES = ["state_changed", "note", "error"] as const;
export const LLM_ROLES = ["planner", "implementer", "verifier"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];
export const LLM_CALL_STATUSES = ["ok", "error"] as const;
/** 失敗の種類（002 research R6）。予算切れは送らないので記録しない */
export const LLM_ERROR_KINDS = ["transient", "permanent", "timeout", "aborted"] as const;
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];
/** デプロイの状態（010 data-model.md 1章） */
export const DEPLOYMENT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];
/** デプロイが失敗した段階（010）。release・health だけがロールバックする */
export const DEPLOY_STAGES = ["fetch", "build", "release", "health", "interrupted"] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];
/** ツールを使う工程の実行1回の終わり方（004 research R12） */
export const AGENT_RUN_OUTCOMES = [
  "completed",
  "max_turns",
  "timeout",
  "budget_exceeded",
  "blocked_repeatedly",
  "aborted",
  "failed",
] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];
/** 判定（phase = judge）の合否（005 data-model.md 1章） */
export const VERDICTS = ["pass", "fail"] as const;
export type VerdictValue = (typeof VERDICTS)[number];

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
    /** 最初の出荷のときの基準の commit（clone した既定のブランチの先頭。009） */
    base_sha: text("base_sha"),
    /** ファクトリーが最後に push した commit（009） */
    head_sha: text("head_sha"),
    /** CI の結論（009）。failed は「やり直しを待つ」 */
    ci_status: text("ci_status", { enum: CI_STATUSES }),
    /** CI 待ちの期限（009） */
    ci_deadline: integer("ci_deadline"),
    /** CI の知らせを受けた印。見回りが評価して消す（009） */
    ci_event_at: integer("ci_event_at"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
    started_at: integer("started_at"),
    finished_at: integer("finished_at"),
  },
  (t) => [
    unique("jobs_repo_trigger_comment_unique").on(t.repo, t.trigger_comment_id),
    index("jobs_status_created_at_idx").on(t.status, t.created_at),
    index("jobs_status_ci_status_idx").on(t.status, t.ci_status),
    check("jobs_status_check", oneOf(t.status, JOB_STATUSES)),
    check("jobs_ci_status_check", oneOf(t.ci_status, CI_STATUSES)),
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
    /** 失敗の種類。成功なら NULL */
    error_kind: text("error_kind", { enum: LLM_ERROR_KINDS }),
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
    check("llm_calls_error_kind_check", oneOf(t.error_kind, LLM_ERROR_KINDS)),
    check(
      "llm_calls_error_kind_status_check",
      sql`(${t.status} = 'ok') = (${t.error_kind} IS NULL)`,
    ),
    check("llm_calls_attempt_check", sql`${t.attempt} >= 1`),
    check("llm_calls_latency_check", sql`${t.latency_ms} >= 0`),
  ],
);

/**
 * 工程の実行1回ごとの要約（constitution 原則 V）。実装（ツールを使う）と、005 の計画・判定（ツールなしの1回呼び出し）。
 * 詳細は軌跡の JSONL（trace_path）に置く。004 data-model.md 1章
 */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    job_id: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    /** 工程は今後増えるので CHECK は付けない（llm_calls.phase と同じ） */
    phase: text("phase").notNull(),
    /** 同じジョブ・同じ工程の何回目か（1 始まり） */
    attempt: integer("attempt").notNull(),
    model: text("model").notNull(),
    /** NULL なら実行中（または途中でファクトリーが落ちた） */
    outcome: text("outcome", { enum: AGENT_RUN_OUTCOMES }),
    turns: integer("turns").notNull().default(0),
    /** この実行で増えた llm_calls の行数（リトライを含む） */
    requests: integer("requests").notNull().default(0),
    tool_calls: integer("tool_calls").notNull().default(0),
    blocked_calls: integer("blocked_calls").notNull().default(0),
    compactions: integer("compactions").notNull().default(0),
    steers: integer("steers").notNull().default(0),
    /** 失敗の原因（マスク済み） */
    error: text("error"),
    /** 判定の合否。判定以外の工程と、判定できなかった回は NULL（005） */
    verdict: text("verdict", { enum: VERDICTS }),
    /** 軌跡のファイル（storage.trace_dir からの相対パス） */
    trace_path: text("trace_path").notNull(),
    started_at: integer("started_at").notNull(),
    finished_at: integer("finished_at"),
  },
  (t) => [
    unique("agent_runs_job_phase_attempt_unique").on(t.job_id, t.phase, t.attempt),
    check("agent_runs_outcome_check", oneOf(t.outcome, AGENT_RUN_OUTCOMES)),
    check("agent_runs_attempt_check", sql`${t.attempt} >= 1`),
    check("agent_runs_verdict_check", oneOf(t.verdict, VERDICTS)),
  ],
);

/** デプロイ1件ごとの記録（010 data-model.md 1章）。積んだ順（id）に1件ずつ処理する */
export const deployments = sqliteTable(
  "deployments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** owner/name */
    repo: text("repo").notNull(),
    /** 人間が直接 main に push した・結び付けられなかった場合は NULL */
    job_id: integer("job_id").references(() => jobs.id),
    /** push の after（デプロイする commit） */
    commit_sha: text("commit_sha").notNull(),
    /** push の before。0 だけ・不明なら NULL */
    before_sha: text("before_sha"),
    image_tag: text("image_tag").notNull(),
    status: text("status", { enum: DEPLOYMENT_STATUSES }).notNull(),
    /** 失敗した段階。failed のときだけ */
    failed_stage: text("failed_stage", { enum: DEPLOY_STAGES }),
    /** ステージングを戻した・止めた */
    rolled_back: integer("rolled_back", { mode: "boolean" }).notNull().default(false),
    /** 戻し先のイメージ。止めたなら NULL */
    rolled_back_to: text("rolled_back_to"),
    /** 戻した版のヘルスチェックが通ったか。戻していない・止めたなら NULL */
    rollback_healthy: integer("rollback_healthy", { mode: "boolean" }),
    revert_pr_number: integer("revert_pr_number"),
    /** 失敗・作らなかった理由など（伏せ字済み） */
    error: text("error"),
    created_at: integer("created_at").notNull(),
    started_at: integer("started_at"),
    finished_at: integer("finished_at"),
  },
  (t) => [
    unique("deployments_repo_commit_unique").on(t.repo, t.commit_sha),
    index("deployments_status_id_idx").on(t.status, t.id),
    index("deployments_job_id_idx").on(t.job_id),
    check("deployments_status_check", oneOf(t.status, DEPLOYMENT_STATUSES)),
    check("deployments_failed_stage_check", oneOf(t.failed_stage, DEPLOY_STAGES)),
    check(
      "deployments_failed_stage_status_check",
      sql`(${t.status} = 'failed') = (${t.failed_stage} IS NOT NULL)`,
    ),
    check(
      "deployments_rollback_check",
      sql`${t.rolled_back} = 1 OR (${t.rolled_back_to} IS NULL AND ${t.rollback_healthy} IS NULL)`,
    ),
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
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type Budget = typeof budget.$inferSelect;
export type NewBudget = typeof budget.$inferInsert;
