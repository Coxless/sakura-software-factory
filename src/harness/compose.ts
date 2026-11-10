/**
 * ツール呼び出しの検査（層3）と結果の整形（層4）の型と合成関数。
 * 形は Pi（@earendil-works/pi-agent-core 1.5.0）の beforeToolCall / afterToolCall /
 * AgentToolResult に合わせてあり、004 でそのまま渡せる。設計: docs/design/04 2章
 */

export type TextContent = { type: "text"; text: string };

/** 結果がエラーになった理由の種類（contracts/tools.md） */
export type ToolErrorKind =
  | "invalid_args"
  | "not_found"
  | "is_directory"
  | "outside_workspace"
  | "no_match"
  | "multiple_matches"
  | "no_change"
  | "timed_out"
  | "sandbox_unavailable"
  | "blocked";

/** 記録用の詳細。モデルには返さない */
export type ToolDetails = {
  tool: string;
  durationMs?: number;
  error?: ToolErrorKind;
  /** 整形（層4）で切り詰めた文字数 */
  trimmedChars?: number;
  /** 整形（層4）で秘密情報を伏せたか */
  masked?: boolean;
  [key: string]: unknown;
};

export type ToolResult = {
  content: TextContent[];
  details: ToolDetails;
  isError: boolean;
};

export type ToolCall = { toolName: string; args: unknown };

export type GuardDecision = { block: true; reason: string; guard: string };

export type Guard = (call: ToolCall, signal?: AbortSignal) => Promise<GuardDecision | undefined>;

export type ResultTransform = (call: ToolCall, result: ToolResult) => Promise<ToolResult>;

/** 文字列1つの結果を作る */
export function textResult(text: string, details: ToolDetails, isError = false): ToolResult {
  return { content: [{ type: "text", text }], details, isError };
}

/**
 * 検査を順に実行し、最初の拒否を返す。残りの検査は呼ばない。
 * 検査が例外を投げたら、安全側に倒して拒否として扱う。
 */
export function composeGuards(...guards: { name: string; guard: Guard }[]): Guard {
  return async (call, signal) => {
    for (const { name, guard } of guards) {
      let decision: GuardDecision | undefined;
      try {
        decision = await guard(call, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          block: true,
          guard: name,
          reason: `検査（${name}）に失敗したため実行しません: ${message}`,
        };
      }
      if (decision) return decision;
    }
    return undefined;
  };
}

/** 整形を順に適用する */
export function composeTransforms(...transforms: ResultTransform[]): ResultTransform {
  return async (call, result) => {
    let current = result;
    for (const transform of transforms) current = await transform(call, current);
    return current;
  };
}
