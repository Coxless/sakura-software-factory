import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  PayloadError,
  parseAgentCommand,
  toAgentRequest,
  toCiEvent,
  toPushEvent,
} from "./events.ts";

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

describe("toCiEvent（009）", () => {
  test("check_suite の completed は check_suite の知らせ", () => {
    expect(toCiEvent("check_suite", fixture("check_suite.completed"))).toEqual({
      kind: "event",
      event: {
        kind: "check_suite",
        repo: "octo-org/demo",
        headBranch: "agent/issue-7-job-1",
        headSha: "0123456789abcdef0123456789abcdef01234567",
      },
    });
  });

  test("head_branch が null でもよい", () => {
    const payload = fixture("check_suite.completed");
    (payload.check_suite as Record<string, unknown>).head_branch = null;
    const result = toCiEvent("check_suite", payload);
    expect(result).toMatchObject({ kind: "event", event: { headBranch: null } });
  });

  test("pull_request の closed はマージ済みかどうかと一緒に返す", () => {
    expect(toCiEvent("pull_request", fixture("pull_request.closed.merged"))).toEqual({
      kind: "event",
      event: { kind: "pull_request_closed", repo: "octo-org/demo", prNumber: 3, merged: true },
    });
    const payload = fixture("pull_request.closed.merged");
    (payload.pull_request as Record<string, unknown>).merged = null;
    expect(toCiEvent("pull_request", payload)).toMatchObject({ event: { merged: false } });
  });

  test.each([
    ["check_suite", "requested"],
    ["check_suite", "rerequested"],
    ["pull_request", "opened"],
    ["pull_request", "synchronize"],
  ])("%s の %s は ignored（action）", (event, action) => {
    const payload = fixture(
      event === "check_suite" ? "check_suite.completed" : "pull_request.closed.merged",
    );
    payload.action = action;
    expect(toCiEvent(event, payload)).toEqual({ kind: "ignored", reason: "action" });
  });

  test("ほかのイベントは ignored（event）", () => {
    expect(toCiEvent("push", {})).toEqual({ kind: "ignored", reason: "event" });
  });

  test("必要な項目がなければ PayloadError", () => {
    const payload = fixture("check_suite.completed");
    delete (payload.check_suite as Record<string, unknown>).head_sha;
    expect(() => toCiEvent("check_suite", payload)).toThrow(PayloadError);
    expect(() => toCiEvent("pull_request", { action: "closed" })).toThrow(PayloadError);
  });
});

describe("toPushEvent（010）", () => {
  test("main への push", () => {
    expect(toPushEvent("push", fixture("push.main"))).toEqual({
      kind: "event",
      event: {
        repo: "octo-org/demo",
        ref: "refs/heads/main",
        defaultBranch: "main",
        before: "1".repeat(40),
        after: "2".repeat(40),
        deleted: false,
      },
    });
  });

  test("deleted を省くと偽、真なら真", () => {
    const { deleted: _omit, ...rest } = fixture("push.main");
    const omitted = toPushEvent("push", rest);
    expect(omitted.kind === "event" && omitted.event.deleted).toBe(false);
    const removed = toPushEvent("push", {
      ...fixture("push.main"),
      deleted: true,
      after: "0".repeat(40),
    });
    expect(removed.kind === "event" && removed.event.deleted).toBe(true);
  });

  test("項目が欠けている・commit の形が違うと PayloadError", () => {
    const { repository: _r, ...noRepo } = fixture("push.main");
    expect(() => toPushEvent("push", noRepo)).toThrow(PayloadError);
    expect(() => toPushEvent("push", { ...fixture("push.main"), after: "abc" })).toThrow(
      PayloadError,
    );
  });

  test("ほかのイベントは ignored", () => {
    expect(toPushEvent("create", fixture("push.main"))).toEqual({
      kind: "ignored",
      reason: "event",
    });
  });
});
