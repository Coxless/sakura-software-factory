import { describe, expect, test } from "vitest";
import { verifySignature } from "./signature.ts";
import { signBody } from "./testing.ts";

// 比較は @octokit/webhooks の verify（中で node:crypto の timingSafeEqual）に任せる。定数時間であることはコードの読みで確かめる
const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ action: "created", comment: { body: "@agent 直して" } });
const bytes = (text: string) => new TextEncoder().encode(text);

describe("verifySignature", () => {
  test("正しい秘密で署名した本文は true", async () => {
    expect(await verifySignature(SECRET, bytes(BODY), signBody(SECRET, BODY))).toBe(true);
  });

  test("署名がないと false", async () => {
    expect(await verifySignature(SECRET, bytes(BODY), undefined)).toBe(false);
    expect(await verifySignature(SECRET, bytes(BODY), "")).toBe(false);
  });

  test("sha256= の形でない署名は false", async () => {
    const hex = signBody(SECRET, BODY).slice("sha256=".length);
    expect(await verifySignature(SECRET, bytes(BODY), hex)).toBe(false);
    expect(await verifySignature(SECRET, bytes(BODY), `sha1=${hex}`)).toBe(false);
  });

  test("別の秘密で署名した本文は false", async () => {
    expect(await verifySignature(SECRET, bytes(BODY), signBody("other-secret", BODY))).toBe(false);
  });

  test("署名のあとで本文を1バイト変えると false", async () => {
    const signature = signBody(SECRET, BODY);
    const tampered = bytes(BODY);
    tampered[10] = (tampered[10] as number) ^ 1;
    expect(await verifySignature(SECRET, tampered, signature)).toBe(false);
  });

  test("空の本文・UTF-8 として壊れた本文は例外ではなく false", async () => {
    expect(await verifySignature(SECRET, new Uint8Array(), signBody(SECRET, ""))).toBe(false);
    expect(await verifySignature(SECRET, new Uint8Array([0xff, 0xfe]), signBody(SECRET, "x"))).toBe(
      false,
    );
  });
});
