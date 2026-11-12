import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PayloadError, parseAgentCommand, toAgentRequest } from "./events.ts";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"));

describe("parseAgentCommand", () => {
  test.each([
    ["@agent 直して", "直して"],
    ["@agent\n続き", "続き"],
    ["@agent 1行目\n2行目\n\n3行目", "1行目\n2行目\n\n3行目"],
    ["\n\n  \n@agent 先頭の空行は飛ばす", "先頭の空行は飛ばす"],
    ["@agent\t直して\r\n続き", "直して\n続き"],
    ["@agent", ""],
    ["@agent   \n  ", ""],
  ])("%j → %j", (body, expected) => {
    expect(parseAgentCommand(body)).toBe(expected);
  });

  test.each([
    ["@agentx 直して"],
    ["@agent-bot 直して"],
    ["> @agent 直して"],
    ["あとで @agent に頼む"],
    ["```\n@agent 直して\n```"],
    ["    @agent インデントしたコード"],
    ["説明\n@agent 2行目の依頼"],
    [""],
  ])("%j は依頼ではない", (body) => {
    expect(parseAgentCommand(body)).toBeUndefined();
  });
});

describe("toAgentRequest", () => {
  test("@agent で始まるコメントは request", () => {
    const result = toAgentRequest(
      "issue_comment",
      "d-1",
      fixture("issue_comment.created.agent"),
      20000,
    );
    expect(result).toEqual({
      kind: "request",
      request: {
        delivery: "d-1",
        repo: "octo-org/demo",
        issueNumber: 7,
        commentId: 6006,
        author: "octo-requester",
        instruction:
          "README のインストール手順に pnpm の場合を足してください\nnpm の手順は残してください",
      },
    });
  });

  test.each([
    ["issue_comment.created.mention", "not_agent"],
    ["issue_comment.created.quote", "not_agent"],
    ["issue_comment.created.code", "not_agent"],
    ["issue_comment.created.agentx", "not_agent"],
    ["issue_comment.created.bot", "bot"],
    ["issue_comment.created.pull_request", "pull_request"],
    ["issue_comment.created.closed", "closed"],
    ["issue_comment.edited.agent", "action"],
  ])("%s は ignored（%s）", (name, reason) => {
    expect(toAgentRequest("issue_comment", "d", fixture(name), 20000)).toEqual({
      kind: "ignored",
      reason,
    });
  });

  test("ボットの種類でなくても、App が書いたコメントは bot", () => {
    const payload = fixture("issue_comment.created.agent");
    const comment = payload.comment as Record<string, unknown>;
    comment.performed_via_github_app = { id: 1, slug: "other-app" };
    expect(toAgentRequest("issue_comment", "d", payload, 20000)).toEqual({
      kind: "ignored",
      reason: "bot",
    });
  });

  test("@agent だけなら empty", () => {
    const result = toAgentRequest(
      "issue_comment",
      "d",
      fixture("issue_comment.created.empty"),
      100,
    );
    expect(result).toMatchObject({ kind: "empty", request: { instruction: "", commentId: 6006 } });
  });

  test("ping は ping、ほかのイベントは ignored（event）", () => {
    expect(toAgentRequest("ping", "d", fixture("ping"), 100)).toEqual({ kind: "ping" });
    expect(toAgentRequest("issues", "d", {}, 100)).toEqual({ kind: "ignored", reason: "event" });
  });

  test("本文は max_chars で切り詰める（サロゲートペアを割らない）", () => {
    const payload = fixture("issue_comment.created.agent");
    (payload.comment as Record<string, unknown>).body = `@agent ${"🏭".repeat(150)}`;
    const result = toAgentRequest("issue_comment", "d", payload, 100);
    expect(result.kind).toBe("request");
    const instruction = (result as { request: { instruction: string } }).request.instruction;
    expect(Array.from(instruction)).toHaveLength(100);
    expect(instruction).toBe("🏭".repeat(100));
  });

  test("必要な項目が欠けた issue_comment は PayloadError（400 にする）", () => {
    const payload = fixture("issue_comment.created.agent");
    delete (payload.comment as Record<string, unknown>).id;
    expect(() => toAgentRequest("issue_comment", "d", payload, 100)).toThrow(PayloadError);
    expect(() => toAgentRequest("issue_comment", "d", "text", 100)).toThrow(PayloadError);
  });
});
