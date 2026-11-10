# Research: サンドボックスと4ツール（sandbox-tools）

実機（Docker 29.9.2、`node:24-slim` の Node 24.22.2）で確かめた結果を含む。確かめた手順と数値は `docs/journal/2026-11-10-003-sandbox-tools.md` に残す。

## R1. コンテナの操作方法

- **Decision**: docker CLI を execa 10.2.1（完全固定）で呼ぶ。`docker run -d … sleep infinity` で作業場を常駐させ、ツールは `docker exec` で実行し、`docker rm -f` で片付ける
- **Rationale**: `03` 5章の決定どおり。依存が少なく、読者がコマンドをそのまま再現できる。`docker exec` 1回は実測で約 80ms で、SC-004（1秒以内）に十分間に合う
- **Alternatives**: dockerode（依存が増え、コマンドで再現しにくい）、ツール呼び出しごとに `docker run --rm`（起動が遅く、作業場の状態を持てない）、`node:child_process` を直接使う（constitution の主要ライブラリが execa）

## R2. 隔離フラグ

- **Decision**: 実装工程の作業場は次で起動する

  ```
  docker run -d --name factory-job-<jobId> \
    --label sakura-factory.sandbox=1 --label sakura-factory.job-id=<jobId> \
    --network none --read-only --tmpfs /tmp:rw,nosuid,size=<tmp_size_mb>m \
    --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit <pids_limit> --memory <memory_mb>m --memory-swap <memory_mb>m --cpus <cpus> \
    --user <uid>:<gid> --env HOME=/tmp --init \
    -v <workspace>:/workspace -v <workspace>/.git:/workspace/.git:ro -w /workspace \
    <image> sleep infinity
  ```
- **Rationale**: constitution 原則 IV と `03` 5章の一覧そのもの。追加したものの理由:
  - `--env HOME=/tmp`: ルートが読み取り専用なので、pnpm・Node のキャッシュの置き場を一時領域にする
  - `--init`: `bash` で残った子プロセスを回収する（ゾンビを残さない）
  - `--memory-swap` を `--memory` と同じ値にし、スワップで上限をすり抜けさせない
  - ラベル: 起動時の残骸の片付け（FR-007）で、ファクトリーが作ったものだけを選ぶ
- **実測**: `--network none` で名前解決が失敗（`getent hosts` が終了コード 2）、`/x` への書き込みは `Read-only file system`、`CapEff: 0000000000000000`、`--pids-limit 64` で `bash: fork: Interrupted system call`
- **Alternatives**: gVisor（`runsc`）は任意で、本機能では扱わない（`03` 5章）

## R3. `.git` を読み取り専用にする

- **Decision**: 作業ディレクトリに `.git` ディレクトリがあれば、`-v <workspace>/.git:/workspace/.git:ro` で重ねてマウントする。ガードでも `.git` と `**/.git/**` への書き込みを拒否する
- **Rationale**: エージェントが `.git/hooks/pre-commit` や `.git/config`（`core.hooksPath`・`core.fsmonitor` など）を書き換えると、ホストが commit したときにホストでコードが動く。ホストには GitHub のトークンがあるので、原則 IV の「秘密情報をコンテナの外に出さない」を破る経路になる。`bash` からの書き込みはガードでは防ぎきれないため、OS の層で塞ぐ
- **実測**: `echo hi > .git/hooks/x` が `Read-only file system` で失敗する
- **残る注意（008 へ）**: ホストの commit では、念のためフックを無効にする（`-c core.hooksPath=/dev/null`）
- **Alternatives**: ガードだけで拒否する（`bash` で迂回できる）、ホストで commit 前に `.git` を検査する（後追いで、見落としうる）

## R4. 実行ユーザーとファイルの所有者

- **Decision**: 既定はホストのファクトリーのプロセスと同じ uid:gid（`process.getuid()` / `getgid()`）。uid が 0（root）になる場合は、設定の `sandbox.user` で別の ID を指定させ、なければ作業場を作らずにエラーにする
- **Rationale**: 作業場が書いたファイルの所有者がホストのファクトリーのユーザーと同じになり、ホストでの commit・削除で権限の問題が起きない。root で動かすことはどの場合も許さない（原則 IV）
- **Alternatives**: イメージの `node` ユーザー（1000）に固定する（ホストのユーザーの ID と違うと所有者がずれる）、user namespace の再マップ（Docker デーモン全体の設定になり、手順が増える）

## R5. 作業場の中から見えるパスの確かめ方（シンボリックリンク）

- **Decision**: パスの確認は2段にする
  1. 名前の上で: `/workspace` を基準に正規化し、`/workspace/` の下でなければ拒否
  2. 実際のパスで: 作業場の中で `realpath -m -- <path>` を実行し、解決後のパスも `/workspace/` の下で、禁止パスでないことを確かめる

  2 はガード（`beforeToolCall`）で行い、書き込みツールの中でも実書き込みの直前に同じ確認をシェルの中で行う（多重防御）
- **Rationale**: 作業ディレクトリに `ci -> .github/workflows/ci.yml` のようなリンクを置かれると、名前の確認だけでは禁止パスへの書き込みを通してしまう。解決はホストではなく作業場の中で行う（ホストで解決すると、リンクの先がホストのファイルになる）
- **Alternatives**: ホストの `fs.realpath`（コンテナ内のリンクの意味とずれる。ホストのファイルを辿る）、シンボリックリンクを一切拒否する（`node_modules/.bin` などの正当なリンクも使えなくなる）

## R6. `bash` の時間切れ

- **Decision**: `docker exec <c> timeout -k 5 <秒> bash -c <command>` で実行し、ホスト側でも execa の `timeout`（上限＋15秒）と `forceKillAfterDelay` を保険にかける。終了コード 124 か 137 で `timeout` が打ち切ったことを判定する
- **Rationale**: 時間切れの判定と子プロセスの終了を作業場の中で済ませられる
- **実測**: `sleep 10` を 2 秒の上限で実行すると、2,078ms で終了コード 124。`sleep 30 &` を残して `bash` が先に終わった場合も、`timeout` がプロセスグループごと止めるため 2,084ms で戻った（`docker exec` は出力のパイプが閉じるまで待つので、背景のプロセスが残ると上限まで待つ）
- **Alternatives**: ホスト側の execa の `timeout` だけ（`docker exec` のクライアントが止まるだけで、作業場の中のプロセスは動き続ける）

## R7. ツールの形（Pi への組み込みは 004）

- **Decision**: Pi のパッケージに依存せず、Pi 1.5.1 の型と同じ形の型を `src/harness/compose.ts` と `src/sandbox/tools.ts` に自前で持つ
  - ツール: `{ name, label, description, parameters, execute(toolCallId, params, signal?) }`。結果は `{ content: [{ type: "text", text }], details, isError }`
  - 実行前の検査: `(call, signal?) => Promise<{ block: true; reason: string } | undefined>`（Pi の `BeforeToolCallResult` の `block` / `reason` と同じ名前）
  - 実行後の整形: `(call, result) => Promise<ToolResult>`（004 で `AfterToolCallResult` の `content` / `details` / `isError` に写す）
- **Rationale**: 002（LLM 層、Pi を入れる）を別の場所で並行して進めているため、003 で Pi を入れると `package.json` とロックファイルの衝突が大きくなる。型の形を合わせておけば、004 の接続は数行で済む
- **確かめた事実**: npm の `@earendil-works/pi-agent-core` の最新は 1.5.1。`beforeToolCall?: (context: BeforeToolCallContext, signal?) => Promise<BeforeToolCallResult | undefined>`、`BeforeToolCallResult = { block?, reason?, terminate? }`、`AgentTool.execute(toolCallId, params, signal?, onUpdate?)`。失敗は「例外か `isError: true`」
- **Alternatives**: 003 で Pi を入れる（002 と衝突）、独自の形にして 004 で変換する（変換の層が増える）

## R8. 禁止パスの一致判定

- **Decision**: Node 24 の `path.posix.matchesGlob` を使う。設定 `tools.deny_write_paths` の既定は `.git`・`.git/**`・`**/.git/**`・`.github/workflows/**`・`.env*`・`**/.env*`・`**/pnpm-lock.yaml`・`**/package-lock.json`・`**/yarn.lock`・`deploy/**`
- **Rationale**: 依存を増やさない（原則 VII）。実測で `**/pnpm-lock.yaml` がルートの `pnpm-lock.yaml` にも一致した
- **`auto_merge.forbidden_paths` と分ける理由**: 001 の `auto_merge.forbidden_paths` は層6（変更されていたら自動マージしない）、本機能の一覧は層3（書き込みを拒否する）で、意味が違う。既定値はほぼ同じだが、`.git` は層3にだけ要る
- **Alternatives**: picomatch・minimatch（依存が増える）

## R9. 危険なコマンドの形

- **Decision**: `bash` のガードは正規表現の一覧で、次の形を拒否する（`harness/guards/commands.ts`）
  - `/`・`/*`・`~`・`$HOME`・`..` を対象にした `rm` の再帰削除
  - `curl` / `wget` の出力をシェルに渡す形（`| sh`、`| bash`、`bash <(curl …)`）
  - `git push`、`git remote add` / `set-url`
  - `sudo`・`su`・`doas`
  - `docker`・`podman`・`nsenter`・`chroot`
  - `mkfs`・`mount`・`umount`・`dd … of=/dev/…`
  - フォーク爆弾（`:(){ :|:& };:`）
- **Rationale**: `04` 2章 層3。ここはやわらかい層で、言い換えで迂回できる前提とする。本当の防御は層5（ネットワークなし・読み取り専用ルート・`.git` 読み取り専用・特権なし）と層6（禁止パスの変更を diff で検出）。それでも、モデルの誤りに早く理由を返して軌道修正させる効果がある
- **Alternatives**: シェルの構文解析（コストに見合わない。どのみち迂回できる）、許可リスト（実装役の自由度が下がりすぎる）

## R10. 依存のインストール

- **Decision**: `docker run --rm --name factory-install-<jobId>` を、ネットワーク以外は R2 と同じフラグで起動し、呼び出し側が渡したコマンド（例 `pnpm install --frozen-lockfile`）を1回だけ実行する。ネットワークは Docker の既定のブリッジ。時間の上限を超えたら `docker rm -f` で止める
- **Rationale**: `03` 4章 #2。秘密情報は渡さない（環境変数は `HOME` だけ）。依存は作業ディレクトリの `node_modules` に入るので、そのあとのネットワークなしの作業場から使える
- **実測**: `file:` 依存を持つ小さなリポジトリで、ブリッジの作業場で `pnpm install --frozen-lockfile`（Done in 44ms）→ ネットワークなしの作業場で `pnpm test` が依存を読めた。pnpm のストアは `HOME=/tmp` の下（一時領域）に作られ、作業ディレクトリを汚さない
- **Alternatives**: 実装工程の作業場に一時的にネットワークをつなぐ（`docker network connect`。つなぎ忘れ・外し忘れの危険がある）

## R11. 作業場のイメージ

- **Decision**: `sandbox/Dockerfile` は `node:24-slim` に `git`・`ripgrep`・`ca-certificates` を apt で足し、`corepack install --global pnpm@12.18.0` で pnpm を入れておく（`COREPACK_HOME=/opt/corepack`、全ユーザーが読める）。タグは `factory-sandbox:latest`、`pnpm run sandbox:build` で作る
- **Rationale**: 作業場はネットワークなしなので、パッケージマネージャーを作業場の中でダウンロードさせない
- **確かめた事実**: `node:24-slim` には `bash`・`coreutils`（`timeout`・`realpath`）はあるが、`git` と `rg` はない。このクラウドの開発環境では `deb.debian.org` へのアクセスがプロキシで拒否されるため、apt の手順は Workshop で確かめる（journal 参照）。pnpm の手順はキャッシュを持ち込んだ検証用イメージで確かめた
- **Alternatives**: `ubuntu:24.04` に Node を入れる（Workshop と同じ OS になるが、公式の Node イメージから外れ、手順が増える）

## R12. Docker が使えない環境でのテスト

- **Decision**: 作業場を使うテスト（`*.docker.test.ts`）は、`docker info` が成功し、かつテスト用イメージ（既定 `factory-sandbox:latest`、`FACTORY_SANDBOX_TEST_IMAGE` で変更可）があるときだけ実行し、ないときは理由を出して飛ばす。検査・整形・合成・引数の検証のテストは Docker なしで必ず実行する
- **Rationale**: FR-027・FR-028。CI（Workshop）で Docker デーモンが動くかは未確認。`pnpm run check` を Docker の有無で失敗させない
- **Alternatives**: Docker のテストを別コマンドに分ける（実行し忘れる）、docker CLI を偽物に差し替える（隔離の確認にならない）
