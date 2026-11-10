# 2026-11-10 003 sandbox-tools（サンドボックスと4ツール）

002（LLM層）を別の場所で進めている間に、003 を spec → plan → tasks → 実装まで進めた。作業はクラウドの開発環境（Ubuntu 24.04、root、Docker 29.9.2）で行い、Workshop は使えなかった。

## Pi に依存しない形にした

003 のツールとガードは、本来は Pi の `AgentTool`・`beforeToolCall`・`afterToolCall` に渡すもの。ただ 002 で Pi を入れるので、003 でも入れると `package.json` と `pnpm-lock.yaml` が両側で変わり、衝突が大きくなる。

- npm から `@earendil-works/pi-agent-core` 1.5.1（最新）を `npm pack` して型だけ読んだ
  - `beforeToolCall?: (context: BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult | undefined>`、`BeforeToolCallResult = { block?, reason?, terminate? }`
  - `AgentTool.execute(toolCallId, params, signal?, onUpdate?)`、結果は `{ content, details, isError?, terminate? }`。失敗は「例外を投げるか `isError: true`」
  - ツールごとに `executionMode: "sequential" | "parallel"` を指定できる
- → 同じ形の型を `src/harness/compose.ts` に自前で持ち、004 では数行の変換で渡すことにした。003 で増えた依存は execa 10.2.1 だけ

## Docker デーモンを自分で起動した

`docker` CLI はあったがデーモンが動いていなかった（`failed to connect to the docker API at unix:///var/run/docker.sock`）。root なので `dockerd &` で起動でき、`node:24-slim` の取得もできた。

Node はホストに 22.23.4 しかなかったので、`node:24-slim` から `docker cp` で `node` のバイナリ（24.22.2）を取り出して使った。`corepack enable` で pnpm 12.18.0 も入った。

## 隔離フラグの実測

```
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 256 --memory 1g --cpus 1 --user 1000:1000 --tmpfs /tmp:rw,size=64m node:24-slim sh -c '…'
```

| 確認 | 結果 |
|---|---|
| `id` | `uid=1000(node)` |
| `touch /x` | `Read-only file system` |
| `touch /tmp/y` | 成功 |
| `grep CapEff /proc/self/status` | `CapEff: 0000000000000000` |
| `getent hosts example.com` | 終了コード 2（名前解決できない） |
| `--pids-limit 64` で `sleep 5 &` を100個 | `bash: fork: Interrupted system call` |
| `docker exec <c> true` | 約 80ms |

`node:24-slim` には `bash` と coreutils（`timeout`・`realpath`）はあるが、`git` と `rg` はない。

## `.git` を読み取り専用にした理由

作業ディレクトリをそのままマウントすると、エージェントが `bash` で `.git/hooks/pre-commit` を書ける。そのあとホストが `git commit` するとフックがホストで動き、GitHub のトークンがある側でコードが実行される。ガード（層3）で `.git` への書き込みを拒否しても、`bash` の `echo … > .git/hooks/x` は止められない。

→ `-v <ws>/.git:/workspace/.git:ro` を重ねてマウントした。`echo hi > .git/hooks/x` は `Read-only file system` で失敗し、`git status` などの読み取りはできる。念のため 008 のホストの commit ではフックを無効にする（`-c core.hooksPath=/dev/null`）。

## シンボリックリンク経由の書き込み

`ci.yml -> .github/workflows/ci.yml` のようなリンクを作業ディレクトリに置かれると、名前だけの確認では禁止パスへの書き込みを通してしまう。

- パスの解決はホストではなく作業場の中で行う（`realpath -m`）。ホストで解決すると、リンクの先がホストのファイルになる
- GNU の `realpath -m` は、先がまだない（ぶら下がった）リンクも辿る: `link -> a/new.yml`（`a/new.yml` はない）で `/w/a/new.yml` が返った。これで「まだない禁止パスのファイルをリンク経由で作る」も止められる
- 書き込みツールの中でも、実際に書く直前に同じ確認をシェルの中で行い（`case "$R" in /workspace/*)`）、解決後のパスに書く

## `bash` の時間切れと背景のプロセス

```
docker exec <c> timeout -k 2 2 bash -c 'echo start; sleep 10; echo never'   # exit=124, 2078ms
docker exec <c> timeout -k 2 2 bash -c 'sleep 30 & echo bg-started'         # exit=0, 2084ms
```

2つ目は `bash` がすぐ終わるのに、`docker exec` は 2 秒待った。背景の `sleep` が出力のパイプを持っているので `docker exec` は閉じるまで待つが、`timeout` が上限でプロセスグループごと止めるので、上限で戻る。ホスト側の execa の `timeout` だけだと `docker exec` のクライアントが止まるだけで、作業場の中のプロセスは動き続ける。→ 作業場の中の `timeout` を主にし、ホスト側は上限＋15秒の保険にした。

## 失敗: プロセス数のテストがほかのテストを壊した

作業場を1つ共有するテストの中で「`--pids-limit` を超えるとフォークに失敗する」を確かめたら、そのあとのテストが軒並み失敗した。`env` の出力が空、`realpath` がリンクを辿らない、など一見無関係な失敗に見えた。

原因は、プロセス数のテストで起動した `sleep 3 &` が残っていて、後続の `docker exec` の `sh -c` がフォークできなかったこと。単独で動かすとどれも通った。→ プロセス数のテストだけ専用の作業場（`pids_limit = 32`）で行うようにした。

## このクラウド環境ではイメージの apt の手順を確かめられなかった

`sandbox/Dockerfile` の `apt-get install git ripgrep` が失敗した。

```
Err:1 http://deb.debian.org/debian bookworm InRelease
  Could not resolve 'deb.debian.org'
E: Unable to locate package git
```

- この環境の外向きの通信はプロキシ経由で、HTTPS の CONNECT しか通らない。`deb.debian.org:443` と `security.debian.org:443` は `connect_rejected`（許可されていないホスト）。`archive.ubuntu.com` は通る
- コンテナの中からは npm のレジストリにも直接出られない（`corepack install` が `Error when performing the request to https://registry.npmjs.org/pnpm/-/pnpm-12.18.0.tgz` で失敗）
- → テストには、ホストの corepack のキャッシュ（`~/.cache/node/corepack/v1/pnpm/12.18.0`）を `COPY` して `corepack install --global pnpm@12.18.0` だけを行った検証用イメージ（git・ripgrep なし）を `factory-sandbox:latest` として使った。`corepack install` はキャッシュがあればネットワークなしで通った
- `.git` を読み取り専用にしたあとの `git status` の確認だけは、イメージに git がないと実行できないので、git がないときは飛ばすようにした
- 本物のイメージのビルド（apt の手順）は Workshop（またはVPS）で `pnpm run sandbox:build` を実行して確かめる必要がある

## 依存のインストール

`file:` 依存を持つ小さなリポジトリで確かめた。

- ブリッジの作業場で `pnpm install --frozen-lockfile` → Done in 44ms。ネットワークなしの作業場で `pnpm test` が依存を読めた
- pnpm のストアは `HOME=/tmp` の下に作られ、作業ディレクトリを汚さない（`node_modules` だけが増える）
- テストのリポジトリの `package.json` に `packageManager: "pnpm@12.18.0"` を書くと、`pnpm install --lockfile-only` が `ERR_PNPM_BAD_CONFIG_DEP … Failed to resolve config dependency pnpm@12.18.0: Failed to fetch metadata from https://registry.npmjs.org/pnpm … invalid peer certificate: UnknownIssuer` で失敗した。pnpm 12 は `packageManager` を見て、自分のバージョンの情報をレジストリに問い合わせる。このクラウド環境のブリッジからはレジストリに届かないため。テストでは `packageManager` を外した。本番の VPS ではブリッジから外に出られるので問題にならない見込みだが、対象リポジトリの `packageManager` と作業場の pnpm のバージョンが違うと、ネットワークなしの作業場で pnpm が動かない可能性がある（まだ確かめていない）

## 数値

- `pnpm run check`（Biome → tsc → Vitest、16ファイル・201テスト、Docker の作業場のテストを含む）: 約 14 秒
- 作業場の用意（`docker run -d`）: テストで 10 秒の上限に対して十分短い（`docker exec` 1回は約 80ms）
- Docker・イメージがないとき: 作業場のテスト 44 件が飛ばされ、理由が1行出る（`イメージ nope:1 がないため、作業場のテストを飛ばします`）。vitest 5 は、全部飛ばしたファイルの `console.warn` を表示しなかったので、理由を `process.stderr.write` で出すテストを1つ足した

## まだ分かっていないこと

- CI（GitHub Actions 上の Workshop）で Docker デーモンが動くか。動かなければ作業場のテストは CI では飛ばされる
- 本物のイメージ（git・ripgrep 入り）のビルドにかかる時間と大きさ
- 対象リポジトリの pnpm のバージョンが作業場と違う場合の挙動
