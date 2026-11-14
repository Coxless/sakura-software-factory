import Type, { type Static } from "typebox";

/**
 * 状況ページ（GET /status）の中身（011 data-model.md）。JSON の形の正はこのスキーマ。
 * 出してはいけない列（依頼の本文・エラー文・軌跡の場所など）はここに入れない（contracts/http-status.md）。
 * 時刻はすべて UTC の Unix ミリ秒
 */

const Count = Type.Integer({ minimum: 0 });
const Millis = Type.Integer({ minimum: 0 });
const NullableMillis = Type.Union([Millis, Type.Null()]);
const NullableInt = Type.Union([Type.Integer(), Type.Null()]);
const NullableString = Type.Union([Type.String(), Type.Null()]);

export const RateSchema = Type.Object(
  {
    numerator: Count,
    denominator: Count,
    /** 分母 0 なら null（表示は「データなし」） */
    ratio: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type Rate = Static<typeof RateSchema>;

const Breakdown = Type.Array(
  Type.Object({ key: Type.String(), count: Count }, { additionalProperties: false }),
);
export type BreakdownItem = Static<typeof Breakdown>[number];

export const JobRowSchema = Type.Object(
  {
    id: Type.Integer(),
    repo: Type.String(),
    issue_number: Type.Integer(),
    pr_number: NullableInt,
    status: Type.String(),
    /** failure_reason の先頭の種類だけ（research R5） */
    failure_kind: NullableString,
    created_at: Millis,
    started_at: NullableMillis,
    finished_at: NullableMillis,
    duration_ms: NullableMillis,
    requests: Count,
  },
  { additionalProperties: false },
);
export type JobRow = Static<typeof JobRowSchema>;

export const RunRowSchema = Type.Object(
  {
    id: Type.Integer(),
    job_id: Type.Integer(),
    phase: Type.String(),
    attempt: Type.Integer(),
    model: Type.String(),
    /** null なら実行中（または途中でファクトリーが落ちた） */
    outcome: NullableString,
    turns: Count,
    requests: Count,
    tool_calls: Count,
    blocked_calls: Count,
    compactions: Count,
    verdict: NullableString,
    started_at: Millis,
    finished_at: NullableMillis,
    duration_ms: NullableMillis,
  },
  { additionalProperties: false },
);
export type RunRow = Static<typeof RunRowSchema>;

export const DeployRowSchema = Type.Object(
  {
    id: Type.Integer(),
    repo: Type.String(),
    job_id: NullableInt,
    /** commit の先頭 12 文字 */
    commit: Type.String(),
    status: Type.String(),
    failed_stage: NullableString,
    rolled_back: Type.Boolean(),
    revert_pr_number: NullableInt,
    created_at: Millis,
    finished_at: NullableMillis,
    duration_ms: NullableMillis,
  },
  { additionalProperties: false },
);
export type DeployRow = Static<typeof DeployRowSchema>;

export const StatusSnapshotSchema = Type.Object(
  {
    generated_at: Millis,
    month: Type.Object(
      { key: Type.String(), start: Millis, end: Millis, time_zone: Type.String() },
      { additionalProperties: false },
    ),
    consumption: Type.Object(
      {
        requests: Count,
        monthly_limit: Count,
        remaining: Count,
        intake_stopped_at: NullableMillis,
        by_role: Breakdown,
        by_model: Breakdown,
        job_requests: Count,
        non_job_requests: Count,
        input_tokens: Count,
        output_tokens: Count,
        errors_by_kind: Breakdown,
      },
      { additionalProperties: false },
    ),
    jobs: Type.Object(
      {
        success: RateSchema,
        by_status: Breakdown,
        failures_by_reason: Breakdown,
        duration_ms: Type.Object(
          {
            count: Count,
            mean: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
            median: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
          },
          { additionalProperties: false },
        ),
        in_progress: Count,
      },
      { additionalProperties: false },
    ),
    ci: Type.Object({ first_pass: RateSchema }, { additionalProperties: false }),
    deployments: Type.Object(
      { success: RateSchema, rolled_back: Count },
      { additionalProperties: false },
    ),
    recent: Type.Object(
      {
        jobs: Type.Array(JobRowSchema),
        runs: Type.Array(RunRowSchema),
        deployments: Type.Array(DeployRowSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type StatusSnapshot = Static<typeof StatusSnapshotSchema>;
