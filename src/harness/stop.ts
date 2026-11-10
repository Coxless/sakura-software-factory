/**
 * ツールを使う工程の停止条件の判定（004 research R5）。Pi に依存しない。
 * ターン数・期限・連続の拒否・作業場の異常を数え、止めるべきなら理由を返す。予算切れと中断は呼び出し側で見分ける。
 */
import type { ToolDetails } from "./compose.ts";

export type StopReason = "max_turns" | "timeout" | "blocked_repeatedly" | "sandbox_unavailable";

export interface StopLimits {
  maxTurns: number;
  /** UTC の Unix ミリ秒 */
  deadline: number;
  maxConsecutiveBlocks: number;
}

/** 作業場が使えないエラーがこの回数続いたら止める（spec Edge Cases） */
export const MAX_CONSECUTIVE_SANDBOX_ERRORS = 3;

export class StopTracker {
  #turns = 0;
  #blocks = 0;
  #sandboxErrors = 0;
  #deadlineAborted = false;
  #reason: StopReason | undefined;

  readonly #limits: StopLimits;
  readonly #now: () => number;

  constructor(limits: StopLimits, now: () => number) {
    this.#limits = limits;
    this.#now = now;
  }

  get turns(): number {
    return this.#turns;
  }

  /** いったん決まった理由（以後は変わらない） */
  get reason(): StopReason | undefined {
    return this.#reason;
  }

  onTurnEnd(): void {
    this.#turns += 1;
  }

  onBlocked(): void {
    this.#blocks += 1;
  }

  /** 拒否されずに実行したツールの結果 */
  onToolResult(details: ToolDetails | undefined): void {
    this.#blocks = 0;
    this.#sandboxErrors = details?.error === "sandbox_unavailable" ? this.#sandboxErrors + 1 : 0;
  }

  /** 期限のタイマーでループを中断した */
  onDeadlineAbort(): void {
    this.#deadlineAborted = true;
    this.#reason ??= "timeout";
  }

  /** 止めるべきなら理由を返す。ターンの終わりに呼ぶ */
  check(): StopReason | undefined {
    if (this.#reason) return this.#reason;
    if (this.#deadlineAborted || this.#now() >= this.#limits.deadline) this.#reason = "timeout";
    else if (this.#sandboxErrors >= MAX_CONSECUTIVE_SANDBOX_ERRORS) {
      this.#reason = "sandbox_unavailable";
    } else if (this.#blocks >= this.#limits.maxConsecutiveBlocks) {
      this.#reason = "blocked_repeatedly";
    } else if (this.#turns >= this.#limits.maxTurns) this.#reason = "max_turns";
    return this.#reason;
  }
}
