---

description: "Task list for 003 sandbox-tools"
---

# Tasks: サンドボックスと4ツール（sandbox-tools）

**Input**: Design documents from `specs/003-sandbox-tools/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 含める。SC-001〜SC-007 が自動テストでの確認を前提にしているため。各ストーリーで、テストを先に書いて失敗を確かめてから実装する。

**Organization**: ユーザーストーリーごとにまとめる。US3（検査）・US4（整形）は Docker なしで完結する。US1（作業場）が US2（ツール）と US5（インストール）の前提。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 並行して進められる（別ファイルで、未完了のタスクに依存しない）
- **[Story]**: 対応するユーザーストーリー（US1〜US5）

## 共通の決まり（全タスク）

- 001 の共通の決まり（Workshop で実行、`.ts` 付きの相対 import、`import type`、`erasableSyntaxOnly`、`typebox` 1.x）に従う
- Docker を使うテストは `*.docker.test.ts` に分け、`src/sandbox/testing.ts` の判定で Docker・イメージがなければ飛ばす
- 想定と違う挙動・エラーに当たったら `docs/journal/2026-11-10-003-sandbox-tools.md` に記録する

---

## Phase 1: Setup

- [X] T001 execa を完全固定で入れる（`execa@10.2.1`）。`package.json` に `^` `~` がないことを確かめる
- [X] T002 [P] `sandbox/Dockerfile` を作る（research R11）。`node:24-slim` → apt で `ca-certificates git ripgrep` → `COREPACK_HOME=/opt/corepack` で `corepack enable && corepack install --global pnpm@12.18.0` → `/opt/corepack` を全員が読めるようにする
- [X] T003 [P] `package.json` に `sandbox:build`（`docker build -t factory-sandbox:latest sandbox`）を足す（contracts/commands.md）

## Phase 2: Foundational（設定）

- [X] T004 `src/config.test.ts` に `[sandbox]` `[tools]` のテストを足す: 省略時の既定値（contracts/factory-toml.md の表）、`user = "0:0"` と `"abc"` がエラー、`bash_timeout_seconds > bash_max_timeout_seconds` がエラー、未知の項目がエラー
- [X] T005 `src/config.ts` に `[sandbox]` `[tools]` のスキーマと追加の検証を足す。`factory.toml` に2つの表を日本語のコメント付きで足す

---

## Phase 3: User Story 3 - ツール呼び出しを実行前に検査する（層3） (Priority: P1)

**Goal**: 検査の合成関数と、パス・コマンドの検査
**Independent Test**: Docker なしで、偽の `resolveRealPath` を使って判定と理由を確かめる

- [X] T006 [P] [US3] `src/harness/compose.test.ts`: 拒否なしなら `undefined`、2番目が拒否なら3番目を呼ばずにその理由を返す、例外を投げた検査は拒否として扱う（理由に検査名を含む）。整形は順に適用される
- [X] T007 [P] [US3] `src/sandbox/paths.test.ts`: `resolveWorkspacePath` が `a/b.ts`・`./a`・`/workspace/a` を `/workspace/a…` に、`../x`・`/etc/passwd`・`a/../../x` を外側と判定、`""`・`.`・`/workspace` を「作業ディレクトリそのもの」と判定。`toRelative` が `/workspace/a/b` → `a/b`
- [X] T008 [P] [US3] `src/harness/guards/paths.test.ts`: 作業ディレクトリ外（名前の上）を拒否、禁止パス（既定の一覧の各規則に1つずつ）への write/edit を拒否し read は許可、偽の `resolveRealPath` でリンクの先が禁止パス・外側のときに拒否、正当なパス（`src/a.ts`、`node_modules/.bin/x` の read）は許可、`bash` は素通し、引数の形が違う（`path` がない）呼び出しは素通し（ツール側の検証に任せる）
- [X] T009 [P] [US3] `src/harness/guards/commands.test.ts`: research R9 の各形に拒否される例を2つ以上、言い換えで許可されるべき例（`rm -rf node_modules`、`git status`、`git diff`、`curl --version`、`pnpm test`、`echo "sudo"` を含まない普通のコマンド）を許可
- [X] T010 [US3] `src/harness/compose.ts`（型と `composeGuards` / `composeTransforms`）、`src/sandbox/paths.ts`、`src/harness/guards/paths.ts`、`src/harness/guards/commands.ts` を書く（contracts/module-api.md、tools.md の文面）
- [X] T011 [US3] `pnpm run check` を通す

---

## Phase 4: User Story 4 - ツールの結果を整える（層4） (Priority: P2)

- [X] T012 [P] [US4] `src/harness/results.test.ts`: 上限以下は変わらない、超えたら先頭と末尾が残り省いた文字数が示され長さが上限＋注記以内、`ghp_…` と秘密鍵のブロックが伏せられる、`details` に `trimmedChars` と `masked` が入る、`isError` は変わらない
- [X] T013 [US4] `src/harness/results.ts` を書く（先頭 30%・末尾 70% を残す）
- [X] T014 [US4] `pnpm run check` を通す

---

## Phase 5: User Story 1 - 隔離された作業場 (Priority: P1)

**Goal**: 作業場の起動・exec・realpath・片付け
**Independent Test**: Docker で隔離の各項目を確かめる（SC-001・SC-002・SC-005・SC-007）

- [X] T015 [P] [US1] `src/sandbox/options.test.ts`（Docker なし）: `buildRunArgs` の結果に R2 のフラグがすべて入る、`.git` があるときだけ読み取り専用のマウントが入る、`--env` は `HOME=/tmp` だけ、`kind: "install"` では `--network none` の代わりにブリッジで `--rm`。`resolveUser` が設定・プロセスの uid から決め、uid 0 は `SandboxError("invalid_user")`
- [X] T016 [US1] `src/sandbox/testing.ts`: `dockerReady()`（`docker info` とイメージの有無。結果をキャッシュし、飛ばす理由を返す）、`makeWorkspace()`（一時ディレクトリに git リポジトリを作り、テストのユーザーが書けるように所有者を変える）、テスト用の設定
- [X] T017 [US1] `src/sandbox/docker.docker.test.ts`: 作業場から読み書きでき、ホストに反映される／外部へ接続できない／`/x` に書けない／`.git/hooks/x` に書けない／uid が 0 でなく `CapEff` が 0／`--pids-limit` を超えるとフォークに失敗する／ホストの環境変数（テストで入れた `SAKURA_AI_API_KEY`）が `env` に出ない／`withSandbox` の中で例外が起きても作業場が残らない／`destroy` を2回呼べる／`removeStaleSandboxes` が残骸を消す／片付け後の `exec` が `SandboxError("unavailable")`／用意が10秒以内／`realpath` がリンクを解決する
- [X] T018 [US1] `src/sandbox/options.ts` と `src/sandbox/docker.ts` を書く。docker のエラー（デーモンなし・イメージなし）を `SandboxError` の種類に分ける。`createSandbox` は失敗時に `docker rm -f` で途中のものを消す
- [X] T019 [US1] `pnpm run check` を通す

---

## Phase 6: User Story 2 - 4つのツール (Priority: P1)

- [X] T020 [US2] `src/sandbox/tools.docker.test.ts`: contracts/tools.md の正常系（行番号・範囲・続きの案内・バイナリ・空ファイル、途中のディレクトリの作成、1か所の置換・全置換・CRLF、終了コード・標準出力・標準エラー・0 以外の終了コード）とエラー（`invalid_args`・`not_found`・`is_directory`・`outside_workspace`・`no_match`・`multiple_matches`・`no_change`・時間切れ・片付け後の `sandbox_unavailable`）、UTF-8 として不正なバイトが置換文字になる、各ツールが1秒以内（SC-004）、ツールの書き込みが作業ディレクトリ外へのリンクを辿らない
- [X] T021 [US2] `src/sandbox/tools.ts` を書く。引数は TypeBox で検証し、`write_file` はシェルの中で `realpath -m` の結果が `/workspace/` の下かを確かめてから書く
- [X] T022 [US2] ツールと検査・整形を合わせた確認を `src/sandbox/tools.docker.test.ts` に足す: リンク経由で禁止パスに書こうとすると `createPathGuard({ resolveRealPath: sandbox.realpath })` が拒否する（SC-003）
- [X] T023 [US2] `pnpm run check` を通す

---

## Phase 7: User Story 5 - 依存のインストール (Priority: P2)

- [X] T024 [US5] `src/sandbox/docker.docker.test.ts` に足す: `file:` 依存を持つリポジトリで `installDependencies` が成功し、そのあとネットワークなしの作業場で依存を使うコマンドが通る／時間の上限で打ち切られて失敗が返り、コンテナが残らない／中の `env` に秘密情報がない
- [X] T025 [US5] `installDependencies` を `src/sandbox/docker.ts` に書く
- [X] T026 [US5] `pnpm run check` を通す

---

## Phase 8: Polish

- [X] T027 [P] `docs/design/03` の5章（サンドボックス）・8章と `04` の2章（層3・層5）を plan.md の「設計ドキュメントとの差分」どおりに直す
- [X] T028 [P] `docs/journal/2026-11-10-003-sandbox-tools.md` に、実測（R2・R3・R6・R10）と、このクラウド環境で apt のミラーに届かずイメージの apt の手順を確かめられなかったことを書く
- [X] T029 quickstart.md の 2・3 章を実行して確かめる（1 章のイメージのビルドは apt が要るため、Workshop で確かめる。journal に残す）
- [X] T030 `pnpm run check` を通し、所要時間を記録する

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3・4（Docker なし、並行可）→ Phase 5 → Phase 6・7 → Phase 8
- US2 の T022 は US3 の検査を使う
