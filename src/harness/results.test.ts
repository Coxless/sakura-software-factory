import { describe, expect, test } from "vitest";
import { composeTransforms, textResult } from "./compose.ts";
import { createTruncateTransform, maskSecretsTransform, truncateMiddle } from "./results.ts";

const call = { toolName: "bash", args: { command: "pnpm test" } };

describe("truncateMiddle", () => {
  test("上限以下は変わらない", () => {
    expect(truncateMiddle("abc", 3)).toEqual({ text: "abc", trimmedChars: 0 });
  });

  test("上限を超えたら先頭 30%・末尾 70% を残し、省いた文字数を示す", () => {
    const text = `HEAD${"x".repeat(10_000)}TAIL`;
    const { text: out, trimmedChars } = truncateMiddle(text, 1000);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(trimmedChars).toBe(text.length - 1000);
    expect(out).toContain(`${trimmedChars} 文字を省きました`);
    const noteLength = out.length - 1000;
    expect(noteLength).toBeGreaterThan(0);
    expect(noteLength).toBeLessThan(100);
  });
});

describe("createTruncateTransform", () => {
  test("長い結果を切り詰め、details に省いた文字数を入れる。isError は変えない", async () => {
    const result = textResult("y".repeat(5000), { tool: "bash", exitCode: 1 }, true);
    const out = await createTruncateTransform(1000)(call, result);
    expect(out.content[0]?.text.length).toBeLessThan(1100);
    expect(out.details).toMatchObject({ tool: "bash", exitCode: 1, trimmedChars: 4000 });
    expect(out.isError).toBe(true);
  });

  test("短い結果はそのまま", async () => {
    const result = textResult("ok", { tool: "bash" });
    expect(await createTruncateTransform(1000)(call, result)).toBe(result);
  });
});

describe("maskSecretsTransform", () => {
  test("トークンと秘密鍵を伏せ、details.masked を立てる", async () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    const token = `ghs_${"A".repeat(36)}`;
    const result = textResult(`token=${token}\n${key}\nok`, { tool: "read_file" });
    const out = await maskSecretsTransform(call, result);
    expect(out.content[0]?.text).toBe("token=[REDACTED]\n[REDACTED]\nok");
    expect(out.details.masked).toBe(true);
  });

  test("秘密情報がなければそのまま", async () => {
    const result = textResult("hello", { tool: "read_file" });
    expect(await maskSecretsTransform(call, result)).toBe(result);
  });

  test("マスクしてから切り詰めると、上限を超えても秘密情報は残らない", async () => {
    const token = `ghp_${"B".repeat(36)}`;
    const text = `${token}${"z".repeat(30_000)}${token}`;
    const transform = composeTransforms(maskSecretsTransform, createTruncateTransform(20_000));
    const out = await transform(call, textResult(text, { tool: "bash" }));
    expect(out.content[0]?.text).not.toContain("ghp_");
    expect(out.content[0]?.text.length).toBeLessThan(20_100);
  });
});
