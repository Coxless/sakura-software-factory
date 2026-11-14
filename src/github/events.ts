import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { AgentRequest, CiEvent, PushEvent } from "./port.ts";

/**
 * issue_comment のペイロードのうち、受付で使う項目だけ（余分な項目は許す）。
 * GitHub の型（@octokit/webhooks）はこの層の外に出さず、ここで AgentRequest に変える（原則 VII）。
 */
const IssueCommentPayload = Type.Object({
  action: Type.String(),
  issue: Type.Object({
    number: Type.Integer({ minimum: 1 }),
    state: Type.String(),
    pull_request: Type.Optional(Type.Unknown()),
  }),
  comment: Type.Object({
    id: Type.Integer({ minimum: 1 }),
    body: Type.Union([Type.String(), Type.Null()]),
    user: Type.Object({ login: Type.String({ minLength: 1 }), type: Type.String() }),
    performed_via_github_app: Type.Optional(Type.Unknown()),
  }),
  repository: Type.Object({ full_name: Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$" }) }),
});
type IssueCommentPayload = Static<typeof IssueCommentPayload>;

/** issue_comment に必要な項目がない（400 にする） */
export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

export type IgnoredReason = "event" | "action" | "pull_request" | "closed" | "bot" | "not_agent";

export type AgentRequestResult =
  | { kind: "request"; request: AgentRequest }
  | { kind: "ignored"; reason: IgnoredReason }
  | { kind: "empty"; request: AgentRequest }
  | { kind: "ping" };

const AGENT_LINE = /^@agent(?:\s|$)/;

/**
 * 依頼の判定（FR-007）。最初の空でない行が @agent（直後が空白か行末）で始まれば、そのあとの本文を返す。
 * 行の先頭に空白・引用（>）・コードの囲みがあれば依頼ではない。依頼でなければ undefined、本文が空なら ""。
 */
export function parseAgentCommand(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() !== "");
  if (index === -1) return undefined;
  const first = lines[index] as string;
  if (!AGENT_LINE.test(first)) return undefined;
  const rest = [first.slice("@agent".length), ...lines.slice(index + 1)].join("\n");
  return rest.trim();
}

/** コードポイントの単位で切り詰める（サロゲートペアを割らない） */
function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("");
}

/** issue_comment のペイロードから依頼を取り出す。依頼でなければ理由付きで返す。項目が欠けていれば PayloadError */
export function toAgentRequest(
  event: string,
  delivery: string,
  payload: unknown,
  maxChars: number,
): AgentRequestResult {
  if (event === "ping") return { kind: "ping" };
  if (event !== "issue_comment") return { kind: "ignored", reason: "event" };
  if (!Value.Check(IssueCommentPayload, payload)) {
    throw new PayloadError("issue_comment のペイロードに必要な項目がありません");
  }
  const { action, issue, comment, repository } = payload as IssueCommentPayload;
  if (action !== "created") return { kind: "ignored", reason: "action" };
  if (issue.pull_request !== undefined && issue.pull_request !== null) {
    return { kind: "ignored", reason: "pull_request" };
  }
  if (issue.state !== "open") return { kind: "ignored", reason: "closed" };
  if (
    comment.user.type === "Bot" ||
    (comment.performed_via_github_app !== undefined && comment.performed_via_github_app !== null)
  ) {
    return { kind: "ignored", reason: "bot" };
  }
  const instruction = parseAgentCommand(comment.body ?? "");
  if (instruction === undefined) return { kind: "ignored", reason: "not_agent" };

  const request: AgentRequest = {
    delivery,
    repo: repository.full_name,
    issueNumber: issue.number,
    commentId: comment.id,
    author: comment.user.login,
    instruction: truncate(instruction, maxChars),
  };
  return instruction === "" ? { kind: "empty", request } : { kind: "request", request };
}

// ---- 009: CI の知らせ（contracts/webhook.md） ----

const Repository = Type.Object({ full_name: Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$" }) });

const CheckSuitePayload = Type.Object({
  action: Type.String(),
  check_suite: Type.Object({
    head_branch: Type.Union([Type.String(), Type.Null()]),
    head_sha: Type.String({ minLength: 1 }),
  }),
  repository: Repository,
});
type CheckSuitePayload = Static<typeof CheckSuitePayload>;

const PullRequestPayload = Type.Object({
  action: Type.String(),
  pull_request: Type.Object({
    number: Type.Integer({ minimum: 1 }),
    merged: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  }),
  repository: Repository,
});
type PullRequestPayload = Static<typeof PullRequestPayload>;

export type CiEventResult =
  | { kind: "event"; event: CiEvent }
  | { kind: "ignored"; reason: "event" | "action" };

/**
 * check_suite（completed）・pull_request（closed）のペイロードから CI の知らせを取り出す（009 research R2）。
 * 知らせは見回りが結論を取り直すきっかけにだけ使い、ペイロードの結論は使わない。項目が欠けていれば PayloadError
 */
export function toCiEvent(event: string, payload: unknown): CiEventResult {
  if (event === "check_suite") {
    if (!Value.Check(CheckSuitePayload, payload)) {
      throw new PayloadError("check_suite のペイロードに必要な項目がありません");
    }
    const { action, check_suite, repository } = payload as CheckSuitePayload;
    if (action !== "completed") return { kind: "ignored", reason: "action" };
    return {
      kind: "event",
      event: {
        kind: "check_suite",
        repo: repository.full_name,
        headBranch: check_suite.head_branch,
        headSha: check_suite.head_sha,
      },
    };
  }
  if (event === "pull_request") {
    if (!Value.Check(PullRequestPayload, payload)) {
      throw new PayloadError("pull_request のペイロードに必要な項目がありません");
    }
    const { action, pull_request, repository } = payload as PullRequestPayload;
    if (action !== "closed") return { kind: "ignored", reason: "action" };
    return {
      kind: "event",
      event: {
        kind: "pull_request_closed",
        repo: repository.full_name,
        prNumber: pull_request.number,
        merged: pull_request.merged === true,
      },
    };
  }
  return { kind: "ignored", reason: "event" };
}

// ---- 010: push の知らせ（contracts/webhook.md） ----

const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });

const PushPayload = Type.Object({
  ref: Type.String({ minLength: 1 }),
  before: Sha,
  after: Sha,
  deleted: Type.Optional(Type.Boolean()),
  repository: Type.Object({
    full_name: Type.String({ pattern: "^[^/\\s]+/[^/\\s]+$" }),
    default_branch: Type.String({ minLength: 1 }),
  }),
});
type PushPayload = Static<typeof PushPayload>;

export type PushEventResult =
  | { kind: "event"; event: PushEvent }
  | { kind: "ignored"; reason: "event" };

/**
 * push のペイロードから知らせを取り出す（010 research R1）。デプロイするかの絞り込みは受付が設定を見て行う。
 * 項目が欠けていれば PayloadError
 */
export function toPushEvent(event: string, payload: unknown): PushEventResult {
  if (event !== "push") return { kind: "ignored", reason: "event" };
  if (!Value.Check(PushPayload, payload)) {
    throw new PayloadError("push のペイロードに必要な項目がありません");
  }
  const { ref, before, after, deleted, repository } = payload as PushPayload;
  return {
    kind: "event",
    event: {
      repo: repository.full_name,
      ref,
      defaultBranch: repository.default_branch,
      before,
      after,
      deleted: deleted === true,
    },
  };
}
