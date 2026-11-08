import { describe, expect, test } from "vitest";
import { monthRange } from "./month.ts";

const at = (iso: string) => Date.parse(iso);

describe("monthRange", () => {
  test("JST の月初ちょうどは新しい月に入る", () => {
    const range = monthRange(at("2026-11-30T15:00:00Z"), "Asia/Tokyo");
    expect(range).toEqual({
      key: "2026-12",
      start: at("2026-11-30T15:00:00Z"),
      end: at("2026-12-31T15:00:00Z"),
    });
  });

  test("JST の月初の直前は前の月", () => {
    const range = monthRange(at("2026-11-30T14:59:59.999Z"), "Asia/Tokyo");
    expect(range).toEqual({
      key: "2026-11",
      start: at("2026-10-31T15:00:00Z"),
      end: at("2026-11-30T15:00:00Z"),
    });
  });

  test("UTC を渡すと UTC の月初で区切る", () => {
    const range = monthRange(at("2026-11-30T15:00:00Z"), "UTC");
    expect(range).toEqual({
      key: "2026-11",
      start: at("2026-11-01T00:00:00Z"),
      end: at("2026-12-01T00:00:00Z"),
    });
  });

  test("12月から翌年1月をまたぐ", () => {
    const range = monthRange(at("2026-12-15T00:00:00Z"), "Asia/Tokyo");
    expect(range.key).toBe("2026-12");
    expect(range.end).toBe(at("2026-12-31T15:00:00Z"));
    expect(monthRange(range.end, "Asia/Tokyo").key).toBe("2027-01");
  });

  test("夏時間のあるタイムゾーンでも月初の 0:00 を返す", () => {
    const range = monthRange(at("2026-04-15T12:00:00Z"), "America/New_York");
    expect(range.start).toBe(at("2026-04-01T04:00:00Z")); // EDT (UTC-4)
    expect(range.end).toBe(at("2026-05-01T04:00:00Z"));
    const march = monthRange(at("2026-03-15T12:00:00Z"), "America/New_York");
    expect(march.start).toBe(at("2026-03-01T05:00:00Z")); // EST (UTC-5)
  });
});
