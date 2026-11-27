/**
 * ビルドの文脈を、ほかのユーザーから読めるようにする。
 * ファクトリーは UMask=0027 で動く（systemd）ので、取得したファイルは 0640・ディレクトリは 0750 になる。
 * Dockerfile の COPY は権限をそのまま写すので、非 root で動くステージングのアプリが自分のファイルを読めなくなる。
 * 置き場所（StateDirectory）が 0750 なので、ホストのほかのユーザーからは見えないまま。
 */
import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function makeReadableByOthers(dir: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(dir, stat.mode | 0o055);
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      makeReadableByOthers(join(dir, name));
    }
    return;
  }
  if (stat.isFile()) chmodSync(dir, stat.mode | 0o044);
}
