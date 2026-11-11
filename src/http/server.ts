import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import type { Hono } from "hono";

export interface StartServerOptions {
  app: Hono;
  host: string;
  port: number;
  /** close() のあと、処理中の要求を待つ上限 */
  shutdownTimeoutSeconds: number;
}

export interface ServerHandle {
  /** 実際に待ち受けているアドレスとポート（port 0 で起動したときに使う） */
  address: AddressInfo;
  /**
   * 新しい接続を止め、処理中の要求を上限まで待ち、超えたら残りの接続を切って終わる。
   * 何度呼んでも同じ Promise を返す
   */
  close(): Promise<void>;
}

/** 待ち受けを始める。listening で resolve し、待ち受けの失敗（ポート使用中など）は host:port を含むエラーで reject する */
export function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const { app, host, port, shutdownTimeoutSeconds } = options;
  // serve() は待ち受けの失敗を listeningListener に返さないので、自分で listen する
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(new Error(`${host}:${port} で待ち受けられません: ${error.message}`, { cause: error }));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      let closing: Promise<void> | undefined;
      resolve({
        address: server.address() as AddressInfo,
        close() {
          closing ??= new Promise<void>((done) => {
            const timer = setTimeout(
              () => server.closeAllConnections(),
              shutdownTimeoutSeconds * 1000,
            );
            timer.unref();
            server.close(() => {
              clearTimeout(timer);
              done();
            });
            // 何も処理していない keep-alive の接続は待たずに閉じる
            server.closeIdleConnections();
          });
          return closing;
        },
      });
    });
  });
}
