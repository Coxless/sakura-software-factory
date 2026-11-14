import Value from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import type { DatabaseHandle } from "../queue/db.ts";
import { migratedMemoryDb } from "../queue/testing.ts";
import { collectStatus } from "./collect.ts";
import { StatusSnapshotSchema } from "./schema.ts";
import { createSeeder } from "./testing.ts";

const TZ = "Asia/Tokyo";
/** 2026-11-14 12:00 JST */
const NOW = Date.UTC(2026, 10, 14, 3);
/** 2026-11-01 00:00 JST */
const MONTH_START = Date.UTC(2026, 9, 31, 15);
/** 今月の中の時刻 */
const IN = MONTH_START + 60_000;
/** 先月（2026-10-31 23:59 JST） */
const LAST = MONTH_START - 60_000;
const MIN = 60_000;

let handle: DatabaseHandle;
afterEach(() => handle?.close());

function setup() {
  handle = migratedMemoryDb();
  const seed = createSeeder(handle.db);
  const collect = () => collectStatus(handle.db, { now: NOW, timeZone: TZ, monthlyLimit: 3000 });
  return { seed, collect };
}

describe("collectStatus: 今月の数値", () => {
  test("記録がなければ 0 件と「データなし」。スキーマに合う", () => {
    const { collect } = setup();
    const s = collect();
    expect(Value.Check(StatusSnapshotSchema, s)).toBe(true);
    expect(s.month).toEqual({
      key: "2026-11",
      start: MONTH_START,
      end: Date.UTC(2026, 10, 30, 15),
      time_zone: TZ,
    });
    expect(s.consumption.requests).toBe(0);
    expect(s.consumption.remaining).toBe(3000);
    expect(s.jobs.success).toEqual({ numerator: 0, denominator: 0, ratio: null });
    expect(s.jobs.duration_ms).toEqual({ count: 0, mean: null, median: null });
    expect(s.ci.first_pass.ratio).toBeNull();
    expect(s.deployments.success.ratio).toBeNull();
    expect(s.recent).toEqual({ jobs: [], runs: [], deployments: [] });
  });

  test("消費: 今月だけを数え、役割・モデル・ジョブ以外・トークン・失敗の種類で分ける", () => {
    const { seed, collect } = setup();
    const jobId = seed.job({ created_at: IN });
    for (let i = 0; i < 300; i++) {
      seed.llmCall({ job_id: jobId, created_at: IN, input_tokens: 10, output_tokens: 2 });
    }
    for (let i = 0; i < 100; i++) {
      seed.llmCall({ job_id: jobId, role: "verifier", model: "model-b", created_at: IN });
    }
    for (let i = 0; i < 10; i++) seed.llmCall({ phase: "smoke", created_at: IN });
    seed.llmCall({ job_id: jobId, status: "error", error_kind: "timeout", created_at: IN });
    seed.llmCall({ job_id: jobId, status: "error", error_kind: "transient", created_at: IN });
    // 先月の分は数えない
    for (let i = 0; i < 5; i++) seed.llmCall({ job_id: jobId, created_at: LAST });
    seed.budgetRow("2026-11", IN + 5 * MIN);

    const c = collect().consumption;
    expect(c.requests).toBe(412);
    expect(c.monthly_limit).toBe(3000);
    expect(c.remaining).toBe(2588);
    expect(c.intake_stopped_at).toBe(IN + 5 * MIN);
    expect(c.by_role).toEqual([
      { key: "implementer", count: 312 },
      { key: "verifier", count: 100 },
    ]);
    expect(c.by_model).toEqual([
      { key: "model-a", count: 312 },
      { key: "model-b", count: 100 },
    ]);
    expect(c.job_requests).toBe(402);
    expect(c.non_job_requests).toBe(10);
    expect(c.input_tokens).toBe(3000);
    expect(c.output_tokens).toBe(600);
    expect(c.errors_by_kind).toEqual([
      { key: "timeout", count: 1 },
      { key: "transient", count: 1 },
    ]);
  });

  test("上限を超えても残りは 0", () => {
    const { seed } = setup();
    for (let i = 0; i < 4; i++) seed.llmCall({ created_at: IN });
    const s = collectStatus(handle.db, { now: NOW, timeZone: TZ, monthlyLimit: 3 });
    expect(s.consumption.remaining).toBe(0);
  });

  test("成功率と失敗の理由: 今月終わったジョブだけ。理由は先頭の種類だけ", () => {
    const { seed, collect } = setup();
    const done = (status: "deployed" | "rolled_back" | "failed", reason: string | null = null) =>
      seed.job({
        status,
        created_at: IN,
        started_at: IN,
        finished_at: IN + 10 * MIN,
        failure_reason: reason,
      });
    for (let i = 0; i < 6; i++) done("deployed");
    done("rolled_back");
    done("failed", "ci_failed: CI が失敗しました（3 回目）");
    done("failed", "ci_failed: CI が失敗しました（3 回目）");
    done("failed", "something_new: 内部の文");
    // 先月に終わったジョブ・終わっていないジョブは数えない
    seed.job({
      status: "failed",
      created_at: LAST,
      finished_at: LAST,
      failure_reason: "timeout: x",
    });
    seed.job({ status: "implementing", created_at: IN, started_at: IN });
    seed.job({ status: "queued", created_at: IN });

    const j = collect().jobs;
    expect(j.success).toEqual({ numerator: 6, denominator: 10, ratio: 0.6 });
    expect(j.by_status).toEqual([
      { key: "deployed", count: 6 },
      { key: "failed", count: 3 },
      { key: "rolled_back", count: 1 },
    ]);
    expect(j.failures_by_reason).toEqual([
      { key: "ci_failed", count: 2 },
      { key: "other", count: 1 },
    ]);
    expect(j.in_progress).toBe(2);
  });

  test("処理時間: 平均と中央値。開始の時刻がないものは除く", () => {
    const { seed, collect } = setup();
    for (const minutes of [10, 20, 60]) {
      seed.job({
        status: "deployed",
        created_at: IN,
        started_at: IN,
        finished_at: IN + minutes * MIN,
      });
    }
    seed.job({ status: "failed", created_at: IN, finished_at: IN + MIN });
    const d = collect().jobs.duration_ms;
    expect(d).toEqual({ count: 3, mean: 30 * MIN, median: 20 * MIN });
  });

  test("処理時間の中央値: 偶数件は真ん中2つの平均", () => {
    const { seed, collect } = setup();
    for (const minutes of [10, 20, 30, 100]) {
      seed.job({
        status: "deployed",
        created_at: IN,
        started_at: IN,
        finished_at: IN + minutes * MIN,
      });
    }
    expect(collect().jobs.duration_ms.median).toBe(25 * MIN);
  });

  test("CI 初回通過率: 1回目の結論だけをジョブごとに数える", () => {
    const { seed, collect } = setup();
    for (let i = 0; i < 4; i++) {
      const id = seed.job({ created_at: IN });
      seed.ciResult(id, 1, "success", IN);
    }
    const retried = seed.job({ created_at: IN });
    seed.ciResult(retried, 1, "failure", IN);
    seed.ciResult(retried, 2, "success", IN + MIN);
    // 先月の結論は数えない
    const old = seed.job({ created_at: LAST });
    seed.ciResult(old, 1, "failure", LAST);
    expect(collect().ci.first_pass).toEqual({ numerator: 4, denominator: 5, ratio: 0.8 });
  });

  test("デプロイ成功率とロールバック: 今月終わったものだけ。ジョブなしも含める", () => {
    const { seed, collect } = setup();
    for (let i = 0; i < 8; i++) seed.deployment({ status: "succeeded", finished_at: IN });
    seed.deployment({ status: "failed", failed_stage: "build", finished_at: IN });
    seed.deployment({
      status: "failed",
      failed_stage: "health",
      rolled_back: true,
      rolled_back_to: "demo:old",
      rollback_healthy: true,
      finished_at: IN,
    });
    seed.deployment({ status: "succeeded", finished_at: LAST });
    seed.deployment({ status: "running", started_at: IN });
    const d = collect().deployments;
    expect(d.success).toEqual({ numerator: 8, denominator: 10, ratio: 0.8 });
    expect(d.rolled_back).toBe(1);
  });
});

describe("collectStatus: 最近の一覧", () => {
  test("ジョブ: 新しい順に 20 件。リクエスト数と所要時間", () => {
    const { seed, collect } = setup();
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push(seed.job({ created_at: IN + i }));
    const last = ids[29] as number;
    seed.llmCall({ job_id: last, created_at: IN });
    seed.llmCall({ job_id: last, created_at: LAST });
    const rows = collect().recent.jobs;
    expect(rows).toHaveLength(20);
    expect(rows[0]?.id).toBe(last);
    expect(rows[0]?.requests).toBe(2);
    expect(rows[0]?.duration_ms).toBeNull();
    expect(rows[19]?.id).toBe(ids[10]);
  });

  test("ジョブ: 所要時間と失敗の種類", () => {
    const { seed, collect } = setup();
    seed.job({
      status: "failed",
      created_at: IN,
      started_at: IN,
      finished_at: IN + 3 * MIN,
      failure_reason: "timeout: 60 分を超えました",
      pr_number: 7,
    });
    const [row] = collect().recent.jobs;
    expect(row).toMatchObject({
      status: "failed",
      failure_kind: "timeout",
      duration_ms: 3 * MIN,
      pr_number: 7,
    });
  });

  test("工程の実行: 新しい順に 30 件。終わっていないものは outcome が null", () => {
    const { seed, collect } = setup();
    const jobId = seed.job({ created_at: IN });
    for (let i = 1; i <= 40; i++) {
      seed.run({
        job_id: jobId,
        attempt: i,
        started_at: IN + i,
        ...(i === 40 ? {} : { outcome: "completed", finished_at: IN + i + 1000 }),
      });
    }
    const rows = collect().recent.runs;
    expect(rows).toHaveLength(30);
    expect(rows[0]).toMatchObject({ attempt: 40, outcome: null, duration_ms: null });
    expect(rows[1]).toMatchObject({ attempt: 39, outcome: "completed", duration_ms: 1000 });
  });

  test("デプロイ: 新しい順に 10 件。commit は先頭 12 文字", () => {
    const { seed, collect } = setup();
    for (let i = 0; i < 15; i++) seed.deployment({ created_at: IN + i });
    const rows = collect().recent.deployments;
    expect(rows).toHaveLength(10);
    expect(rows[0]?.commit).toHaveLength(12);
    expect(rows[0]?.commit).toBe("000f00000000");
    expect(rows[0]?.rolled_back).toBe(false);
  });
});

describe("collectStatus: 量", () => {
  test("1か月分（呼び出し 3,000 件・ジョブ 500 件）でも 1 秒以内", () => {
    const { seed, collect } = setup();
    handle.sqlite.transaction(() => {
      const jobIds: number[] = [];
      for (let i = 0; i < 500; i++) {
        const id = seed.job({
          status: "deployed",
          created_at: IN + i,
          started_at: IN + i,
          finished_at: IN + i + 10 * MIN,
        });
        jobIds.push(id);
        seed.ciResult(id, 1, "success", IN + i);
        seed.run({ job_id: id, started_at: IN + i, outcome: "completed", finished_at: IN + i + 1 });
      }
      for (let i = 0; i < 3000; i++) {
        seed.llmCall({ job_id: jobIds[i % 500] as number, created_at: IN + i });
      }
    })();
    const started = performance.now();
    const s = collect();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(s.consumption.requests).toBe(3000);
  });
});
