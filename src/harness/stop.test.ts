import { describe, expect, test } from "vitest";
import { StopTracker } from "./stop.ts";

const limits = { maxTurns: 3, deadline: 1000, maxConsecutiveBlocks: 2 };

describe("StopTracker", () => {
  test("ターン数が上限に達したら max_turns", () => {
    const tracker = new StopTracker(limits, () => 0);
    tracker.onTurnEnd();
    tracker.onTurnEnd();
    expect(tracker.check()).toBeUndefined();
    tracker.onTurnEnd();
    expect(tracker.check()).toBe("max_turns");
    expect(tracker.turns).toBe(3);
  });

  test("期限を過ぎたら timeout。期限のタイマーで中断したときも timeout", () => {
    let now = 999;
    const tracker = new StopTracker(limits, () => now);
    expect(tracker.check()).toBeUndefined();
    now = 1000;
    expect(tracker.check()).toBe("timeout");

    const aborted = new StopTracker(limits, () => 0);
    aborted.onDeadlineAbort();
    expect(aborted.reason).toBe("timeout");
    expect(aborted.check()).toBe("timeout");
  });

  test("拒否が続いたら blocked_repeatedly。間に拒否されない結果があれば数え直す", () => {
    const tracker = new StopTracker(limits, () => 0);
    tracker.onBlocked();
    tracker.onToolResult({ tool: "read_file" });
    tracker.onBlocked();
    expect(tracker.check()).toBeUndefined();
    tracker.onBlocked();
    expect(tracker.check()).toBe("blocked_repeatedly");
  });

  test("作業場が使えないエラーが3回続いたら sandbox_unavailable", () => {
    const tracker = new StopTracker({ ...limits, maxTurns: 100 }, () => 0);
    const down = { tool: "bash", error: "sandbox_unavailable" as const };
    tracker.onToolResult(down);
    tracker.onToolResult(down);
    tracker.onToolResult({ tool: "bash" });
    tracker.onToolResult(down);
    tracker.onToolResult(down);
    expect(tracker.check()).toBeUndefined();
    tracker.onToolResult(down);
    expect(tracker.check()).toBe("sandbox_unavailable");
  });

  test("いったん決まった理由は変わらない", () => {
    let now = 0;
    const tracker = new StopTracker(limits, () => now);
    tracker.onTurnEnd();
    tracker.onTurnEnd();
    tracker.onTurnEnd();
    expect(tracker.check()).toBe("max_turns");
    now = 5000;
    tracker.onDeadlineAbort();
    expect(tracker.check()).toBe("max_turns");
  });
});
