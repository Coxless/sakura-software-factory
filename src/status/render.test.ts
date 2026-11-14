import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { rate } from "./collect.ts";
import { formatDuration, formatRate, formatTime, renderStatusHtml, styleHash } from "./render.ts";
import type { StatusSnapshot } from "./schema.ts";

const TZ = "Asia/Tokyo";
const NOW = Date.UTC(2026, 10, 14, 3);

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    generated_at: NOW,
    month: { key: "2026-11", start: 0, end: 1, time_zone: TZ },
    consumption: {
      requests: 412,
      monthly_limit: 3000,
      remaining: 2588,
      intake_stopped_at: null,
      by_role: [{ key: "implementer", count: 412 }],
      by_model: [{ key: "model-a", count: 412 }],
      job_requests: 402,
      non_job_requests: 10,
      input_tokens: 0,
      output_tokens: 0,
      errors_by_kind: [],
    },
    jobs: {
      success: rate(6, 10),
      by_status: [{ key: "deployed", count: 6 }],
      failures_by_reason: [{ key: "ci_failed", count: 2 }],
      duration_ms: { count: 3, mean: 3_723_000, median: 1_200_000 },
      in_progress: 1,
    },
    ci: { first_pass: rate(0, 0) },
    deployments: { success: rate(8, 10), rolled_back: 1 },
    recent: { jobs: [], runs: [], deployments: [] },
    ...overrides,
  };
}

describe("表記", () => {
  test("率", () => {
    expect(formatRate(rate(6, 10))).toBe("60.0%（6/10）");
    expect(formatRate(rate(0, 0))).toBe("データなし");
  });
  test("時間", () => {
    expect(formatDuration(3_723_000)).toBe("1時間2分3秒");
    expect(formatDuration(65_000)).toBe("1分5秒");
    expect(formatDuration(4_000)).toBe("4秒");
    expect(formatDuration(null)).toBe("—");
  });
  test("時刻は月と同じタイムゾーン", () => {
    expect(formatTime(NOW, TZ)).toBe("2026-11-14 12:00");
  });
});

describe("renderStatusHtml", () => {
  test("5つの数値が出る", async () => {
    const page = await renderStatusHtml(snapshot());
    expect(page).toContain("412 / 3000");
    expect(page).toContain("残り 2588 リクエスト");
    expect(page).toContain("60.0%（6/10）");
    expect(page).toContain("1時間2分3秒");
    expect(page).toContain("データなし");
    expect(page).toContain("80.0%（8/10）");
    expect(page).toContain("ロールバック 1 件");
    expect(page).not.toContain("受付を止めています");
  });

  test("受付を止めていれば、その時刻を出す", async () => {
    const s = snapshot();
    s.consumption.intake_stopped_at = NOW;
    expect(await renderStatusHtml(s)).toContain("受付を止めています（2026-11-14 12:00）");
  });

  test("記録の文字列はエスケープし、スクリプトのタグを出さない", async () => {
    const s = snapshot();
    s.recent.jobs.push({
      id: 1,
      repo: '<script>alert("x")</script>',
      issue_number: 2,
      pr_number: null,
      status: "failed",
      failure_kind: "other",
      created_at: NOW,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      requests: 0,
    });
    s.recent.runs.push({
      id: 1,
      job_id: 1,
      phase: "<img src=x onerror=alert(1)>",
      attempt: 1,
      model: "m",
      outcome: null,
      turns: 0,
      requests: 0,
      tool_calls: 0,
      blocked_calls: 0,
      compactions: 0,
      verdict: null,
      started_at: NOW,
      finished_at: null,
      duration_ms: null,
    });
    const page = await renderStatusHtml(s);
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("実行中");
  });

  test("CSP のハッシュは <style> の中身と一致する", async () => {
    const page = await renderStatusHtml(snapshot());
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1];
    expect(style).toBeDefined();
    const hash = `sha256-${createHash("sha256")
      .update(style as string)
      .digest("base64")}`;
    expect(styleHash()).toBe(hash);
    expect(page.match(/<style>/g)).toHaveLength(1);
  });
});
