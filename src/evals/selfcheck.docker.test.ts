/**
 * 作業場（Docker）を使う自己確認（012 FR-034、SC-004）。Docker とイメージがなければ理由を出して飛ばす。
 * リポジトリの evals/ の全ケースで「何もしなければ合格条件が落ち、模範解答で通る」ことを、本物の作業場の中で確かめる。
 */
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { FactoryConfig } from "../config.ts";
import { testConfig } from "../llm/testing.ts";
import { dockerSkipReason, reportSkip, testSandboxConfig } from "../sandbox/testing.ts";
import { loadEvalSet } from "./cases.ts";
import { prepareCase } from "./prepare.ts";
import { selfCheck } from "./selfcheck.ts";

const skip = await dockerSkipReason();
reportSkip(skip);

describe.skipIf(skip)("evals/ の自己確認（作業場）", () => {
  test("全ケースで ok", async () => {
    const base = testConfig();
    const config = { ...base, sandbox: testSandboxConfig() } as FactoryConfig;
    const set = loadEvalSet(resolve(import.meta.dirname, "../../evals"));
    const results = await selfCheck(set, config, prepareCase);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(set.cases.length);
  }, 600_000);
});
