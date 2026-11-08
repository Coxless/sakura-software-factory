import { describe, expect, test } from "vitest";
import { maskSecrets } from "./mask.ts";

describe("maskSecrets", () => {
  test("Bearer トークンを伏せる", () => {
    expect(maskSecrets("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test.each([
    "ghp_aBcD1234567890aBcD1234567890aBcD12",
    "ghs_aBcD1234567890aBcD1234567890aBcD12",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
  ])("GitHub のトークン %s を伏せる", (token) => {
    expect(maskSecrets(`token=${token} end`)).toBe("token=[REDACTED] end");
  });

  test("PEM の秘密鍵のブロックを伏せる", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
      "abcdef==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(maskSecrets(`key:\n${pem}\nafter`)).toBe("key:\n[REDACTED]\nafter");
  });

  test("秘密情報を含まない文字列は変わらない", () => {
    const text = "ジョブ 42 を planning に移した（ghp は略語）";
    expect(maskSecrets(text)).toBe(text);
  });
});
