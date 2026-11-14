import type { StagingRuntime } from "./staging.ts";

export interface FakeStagingCall {
  method: keyof StagingRuntime;
  image?: string;
  dir?: string;
  images?: readonly string[];
}

/** テスト用の偽の StagingRuntime。呼び出しを記録し、結果を決められる */
export class FakeStaging implements StagingRuntime {
  readonly calls: FakeStagingCall[] = [];
  /** 手元にあるイメージ（build で足し、removeImages で消す） */
  readonly images = new Set<string>();
  /** 今 compose で動いているイメージ。止めたら undefined */
  running: string | undefined;
  /** 失敗させる操作。image を指定するとそのイメージのときだけ */
  fail: Partial<Record<"build" | "up" | "down", Error | { image: string; error: Error }>> = {};
  /** build の中で待つ（中断のテスト）。signal で打ち切られる */
  buildHook?: (signal?: AbortSignal) => Promise<void>;

  private failure(method: "build" | "up" | "down", image?: string): Error | undefined {
    const f = this.fail[method];
    if (!f) return undefined;
    if (f instanceof Error) return f;
    return f.image === image ? f.error : undefined;
  }

  async build(req: { dir: string; image: string; signal?: AbortSignal }): Promise<void> {
    this.calls.push({ method: "build", image: req.image, dir: req.dir });
    await this.buildHook?.(req.signal);
    if (req.signal?.aborted) throw new Error("中断しました");
    const error = this.failure("build", req.image);
    if (error) throw error;
    this.images.add(req.image);
  }

  async up(req: { image: string; signal?: AbortSignal }): Promise<void> {
    this.calls.push({ method: "up", image: req.image });
    const error = this.failure("up", req.image);
    if (error) throw error;
    this.running = req.image;
  }

  async down(): Promise<void> {
    this.calls.push({ method: "down" });
    const error = this.failure("down");
    if (error) throw error;
    this.running = undefined;
  }

  async imageExists(image: string): Promise<boolean> {
    this.calls.push({ method: "imageExists", image });
    return this.images.has(image);
  }

  async removeImages(images: readonly string[]): Promise<string[]> {
    this.calls.push({ method: "removeImages", images });
    const removed = images.filter((image) => this.images.delete(image));
    return removed;
  }

  count(method: keyof StagingRuntime): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}
