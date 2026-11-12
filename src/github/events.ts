import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { AgentRequest } from "./port.ts";

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
