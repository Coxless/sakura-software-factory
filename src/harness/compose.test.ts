import { describe, expect, test } from "vitest";
import {
  composeGuards,
  composeTransforms,
  type Guard,
  type ResultTransform,
  textResult,
} from "./compose.ts";

const call = { toolName: "bash", args: { command: "ls" } };

describe("composeGuards", () => {
  test("どれも拒否しなければ undefined", async () => {
    const allow: Guard = async () => undefined;
    const guard = composeGuards({ name: "a", guard: allow }, { name: "b", guard: allow });
    expect(await guard(call)).toBeUndefined();
  });

  test("最初の拒否を返し、後ろの検査は呼ばない", async () => {
    const called: string[] = [];
    const make =
      (name: string, reject: boolean): Guard =>
      async () => {
        called.push(name);
        return reject ? { block: true, guard: name, reason: `${name} が拒否` } : undefined;
      };
    const guard = composeGuards(
      { name: "a", guard: make("a", false) },
      { name: "b", guard: make("b", true) },
      { name: "c", guard: make("c", true) },
    );
    expect(await guard(call)).toEqual({ block: true, guard: "b", reason: "b が拒否" });
    expect(called).toEqual(["a", "b"]);
  });

  test("例外を投げた検査は拒否として扱い、理由に検査名を含める", async () => {
    const guard = composeGuards({
      name: "path",
      guard: async () => {
        throw new Error("作業場が使えません");
      },
    });
    const decision = await guard(call);
    expect(decision?.block).toBe(true);
    expect(decision?.guard).toBe("path");
    expect(decision?.reason).toContain("path");
    expect(decision?.reason).toContain("作業場が使えません");
  });
});

describe("composeTransforms", () => {
  test("順に適用する", async () => {
    const append =
      (suffix: string): ResultTransform =>
      async (_call, result) =>
        textResult(`${result.content[0]?.text}${suffix}`, result.details, result.isError);
    const transform = composeTransforms(append("1"), append("2"));
    const result = await transform(call, textResult("x", { tool: "bash" }));
    expect(result.content[0]?.text).toBe("x12");
  });

  test("空なら結果をそのまま返す", async () => {
    const original = textResult("x", { tool: "bash" }, true);
    expect(await composeTransforms()(call, original)).toBe(original);
  });
});
