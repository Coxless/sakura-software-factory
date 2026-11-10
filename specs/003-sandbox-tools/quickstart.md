# Quickstart: サンドボックスと4ツールの動作確認

003 が仕様どおりに動くことを手で確かめる手順。コマンドは Workshop の中で実行する（001 の quickstart の「前提」と同じ `w bash -c 'cd /project && …'`）。Workshop の `dev` には `setup-base` で `docker.io` が入っている。

## 1. イメージを作る

```bash
pnpm run sandbox:build
docker run --rm factory-sandbox:latest sh -c 'node -v && pnpm -v && git --version && rg --version | head -1'
```

期待: Node 24、pnpm 12.18.0、git、ripgrep のバージョンが出る。

## 2. 自動テスト（SC-001〜SC-007）

```bash
pnpm run check
```

期待: 終了コード 0。Docker とイメージがあれば `src/sandbox/*.docker.test.ts` も実行される（`skipped` にならない）。Docker がない環境では、それらが飛ばされ、理由が1行出る。

## 3. 隔離を手で確かめる（US1）

```bash
mkdir -p /tmp/ws && cd /tmp/ws && git init -q && echo hi > a.txt
node --input-type=module -e '
  import { withSandbox } from "/project/src/sandbox/docker.ts";
  import { loadConfig } from "/project/src/config.ts";
  const { sandbox } = loadConfig("/project/factory.toml");
  await withSandbox({ jobId: 1, workspace: "/tmp/ws", sandbox }, async (s) => {
    for (const cmd of ["id", "getent hosts example.com", "touch /x", "touch .git/x", "grep CapEff /proc/self/status", "env"]) {
      const r = await s.exec(["sh", "-c", cmd]);
      console.log(`$ ${cmd} -> ${r.exitCode}\n${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}`);
    }
  });'
docker ps -a --filter label=sakura-factory.sandbox=1   # 何も残っていない
```

期待: `id` が root でない。名前解決・`/x`・`.git/x` が失敗。`CapEff` が全部 0。`env` に `HOME=/tmp` などしかなく、ホストの秘密情報がない。

## 4. ツールと検査を手で確かめる（US2〜US4）

自動テストの `src/sandbox/tools.docker.test.ts` と `src/harness/guards/*.test.ts` が、contracts/tools.md の正常系・エラー・拒否の文面をすべて確かめる。手で試すときは、上の `withSandbox` の中で `createTools(s, config.tools)` を作り、`execute("t1", { path: "a.txt" })` のように呼ぶ。
