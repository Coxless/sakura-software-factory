import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_DENY_WRITE_PATHS } from "../config.ts";
import { composeGuards, type ToolResult } from "../harness/compose.ts";
import { createCommandGuard } from "../harness/guards/commands.ts";
import { createPathGuard } from "../harness/guards/paths.ts";
import { createSandbox, type Sandbox } from "./docker.ts";
import {
  dockerSkipReason,
  makeWorkspace,
  reportSkip,
  testSandboxConfig,
  testToolsConfig,
} from "./testing.ts";
import { createTools, type FactoryTool } from "./tools.ts";

const skip = await dockerSkipReason();
reportSkip(skip);

let nextJobId = 800_000 + (process.pid % 1000) * 100;

const text = (result: ToolResult) => result.content[0]?.text ?? "";

describe.skipIf(skip)("4ツール（US2）", () => {
  let ws: Awaited<ReturnType<typeof makeWorkspace>>;
  let sandbox: Sandbox;
  let tools: Record<string, FactoryTool>;
  const call = (name: string, params: unknown) => {
    const tool = tools[name];
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute("t", params);
  };

  beforeAll(async () => {
    ws = await makeWorkspace({
      "src/a.ts": "const a = 1;\nconst b = 2;\nconst a2 = 1;\n",
      "src/dup.ts": "x\nx\nx\n",
      "src/crlf.ts": "line1\r\nline2\r\nline3\r\n",
      "empty.txt": "",
      "long.txt": `${Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    });
    writeFileSync(join(ws.path, "bin.dat"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    writeFileSync(join(ws.path, "bad-utf8.txt"), Buffer.from([0x61, 0xff, 0x62, 0x0a]));
    symlinkSync("/etc/hostname", join(ws.path, "outside-link"));
    sandbox = await createSandbox({
      jobId: nextJobId++,
      workspace: ws.path,
      sandbox: testSandboxConfig(),
    });
    tools = Object.fromEntries(createTools(sandbox, testToolsConfig()).map((t) => [t.name, t]));
  });

  afterAll(async () => {
    await sandbox?.destroy();
    ws?.cleanup();
  });

  test("4つが Pi の AgentTool の形で、逐次実行", () => {
    expect(Object.keys(tools)).toEqual(["read_file", "write_file", "edit_file", "bash"]);
    for (const tool of Object.values(tools)) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });

  describe("read_file", () => {
    test("行番号付きで返す", async () => {
      const result = await call("read_file", { path: "src/a.ts" });
      expect(result.isError).toBe(false);
      expect(text(result)).toBe(
        "     1\tconst a = 1;\n     2\tconst b = 2;\n     3\tconst a2 = 1;",
      );
      expect(result.details).toMatchObject({ tool: "read_file", path: "src/a.ts", totalLines: 3 });
      expect(result.details.durationMs).toBeTypeOf("number");
    });

    test("範囲を指定でき、続きの読み方を示す", async () => {
      const result = await call("read_file", { path: "long.txt", offset: 10, limit: 5 });
      expect(text(result)).toContain("    10\tline 10");
      expect(text(result)).toContain("    14\tline 14");
      expect(text(result)).not.toContain("line 15");
      expect(text(result)).toContain("250行中 10〜14行目。続きは offset: 15");
    });

    test("read_max_lines を超えると切り詰めて続きを示す", async () => {
      const result = await call("read_file", { path: "long.txt" });
      expect(text(result)).toContain("   100\tline 100");
      expect(text(result)).not.toContain("line 101");
      expect(text(result)).toContain("offset: 101");
      expect(result.details.truncated).toBe(true);
    });

    test("バイナリは内容を返さない", async () => {
      const result = await call("read_file", { path: "bin.dat" });
      expect(text(result)).toBe("バイナリファイルです（5 バイト）。内容は返しません");
      expect(result.details.binary).toBe(true);
    });

    test("空のファイル", async () => {
      expect(text(await call("read_file", { path: "empty.txt" }))).toBe("（空のファイルです）");
    });

    test("UTF-8 として不正なバイトは置換文字にする", async () => {
      expect(text(await call("read_file", { path: "bad-utf8.txt" }))).toBe("     1\ta�b");
    });

    test("ないファイル・ディレクトリ・外側・offset 超過はエラーの結果", async () => {
      const cases: [unknown, string, string][] = [
        [{ path: "nope.ts" }, "not_found", "ファイルがありません: nope.ts"],
        [{ path: "src" }, "is_directory", "ディレクトリです: src"],
        [{ path: "." }, "is_directory", "ディレクトリです"],
        [{ path: "../etc/passwd" }, "outside_workspace", "作業ディレクトリの外"],
        [{ path: "outside-link" }, "outside_workspace", "実際のパスは作業ディレクトリの外"],
        [{ path: "src/a.ts", offset: 99 }, "invalid_args", "offset（99）"],
        [{}, "invalid_args", "引数が正しくありません"],
        [{ path: "a", extra: 1 }, "invalid_args", "引数が正しくありません"],
      ];
      for (const [params, kind, message] of cases) {
        const result = await call("read_file", params);
        expect(result.isError, JSON.stringify(params)).toBe(true);
        expect(result.details.error).toBe(kind);
        expect(text(result)).toContain(message);
      }
    });
  });

  describe("write_file", () => {
    test("途中のディレクトリを作って書き、ホストに反映される", async () => {
      const result = await call("write_file", {
        path: "new/dir/b.ts",
        content: "export const b = 1;\n",
      });
      expect(result.isError).toBe(false);
      expect(text(result)).toBe("new/dir/b.ts に書き込みました（新規、20 バイト）");
      expect(readFileSync(join(ws.path, "new/dir/b.ts"), "utf8")).toBe("export const b = 1;\n");
      const again = await call("write_file", { path: "new/dir/b.ts", content: "" });
      expect(text(again)).toContain("上書き、0 バイト");
      expect(readFileSync(join(ws.path, "new/dir/b.ts"), "utf8")).toBe("");
    });

    test("日本語・改行・シェルの特殊文字をそのまま書く", async () => {
      const content = "こんにちは $HOME `id` \"q\" 'q'\n\\n\r\n";
      await call("write_file", { path: "special.txt", content });
      expect(readFileSync(join(ws.path, "special.txt"), "utf8")).toBe(content);
    });

    test("外側を指すリンクを辿って書かない", async () => {
      const result = await call("write_file", { path: "outside-link", content: "x" });
      expect(result.details.error).toBe("outside_workspace");
    });

    test("ディレクトリには書けない", async () => {
      expect((await call("write_file", { path: "src", content: "x" })).details.error).toBe(
        "is_directory",
      );
    });
  });

  describe("edit_file", () => {
    test("1か所だけ置き換える", async () => {
      await call("write_file", { path: "e1.ts", content: "const a = 1;\nconst b = 2;\n" });
      const result = await call("edit_file", {
        path: "e1.ts",
        old_string: "const b = 2;",
        new_string: "const b = 3;",
      });
      expect(text(result)).toBe("e1.ts を編集しました（1か所）");
      expect(readFileSync(join(ws.path, "e1.ts"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
    });

    test("置換先の $& などを特別扱いしない", async () => {
      await call("write_file", { path: "e2.ts", content: "X\n" });
      await call("edit_file", { path: "e2.ts", old_string: "X", new_string: "$& $1 $$" });
      expect(readFileSync(join(ws.path, "e2.ts"), "utf8")).toBe("$& $1 $$\n");
    });

    test("複数あればエラー、replace_all なら全部", async () => {
      const multiple = await call("edit_file", {
        path: "src/dup.ts",
        old_string: "x",
        new_string: "y",
      });
      expect(multiple.details.error).toBe("multiple_matches");
      expect(text(multiple)).toContain("3 か所");
      expect(readFileSync(join(ws.path, "src/dup.ts"), "utf8")).toBe("x\nx\nx\n");
      const all = await call("edit_file", {
        path: "src/dup.ts",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      });
      expect(text(all)).toContain("3か所");
      expect(readFileSync(join(ws.path, "src/dup.ts"), "utf8")).toBe("y\ny\ny\n");
    });

    test("見つからない・同じ・ないファイルはエラーで、ファイルを変えない", async () => {
      const before = readFileSync(join(ws.path, "src/a.ts"), "utf8");
      expect(
        (await call("edit_file", { path: "src/a.ts", old_string: "nope", new_string: "x" })).details
          .error,
      ).toBe("no_match");
      expect(
        (await call("edit_file", { path: "src/a.ts", old_string: "a", new_string: "a" })).details
          .error,
      ).toBe("no_change");
      expect(
        (await call("edit_file", { path: "nope.ts", old_string: "a", new_string: "b" })).details
          .error,
      ).toBe("not_found");
      expect(
        (await call("edit_file", { path: "bin.dat", old_string: "P", new_string: "Q" })).details
          .error,
      ).toBe("invalid_args");
      expect(readFileSync(join(ws.path, "src/a.ts"), "utf8")).toBe(before);
    });

    test("CRLF のファイルは改行コードを保つ", async () => {
      const result = await call("edit_file", {
        path: "src/crlf.ts",
        old_string: "line1\nline2",
        new_string: "first\nsecond",
      });
      expect(result.isError).toBe(false);
      expect(readFileSync(join(ws.path, "src/crlf.ts"), "utf8")).toBe(
        "first\r\nsecond\r\nline3\r\n",
      );
    });
  });

  describe("bash", () => {
    test("終了コードと標準出力・標準エラーを返す。0 以外もエラーではない", async () => {
      const ok = await call("bash", { command: "echo out; echo err >&2" });
      expect(text(ok)).toBe("exit_code: 0\n--- stdout ---\nout\n--- stderr ---\nerr");
      expect(ok.isError).toBe(false);
      const ng = await call("bash", { command: "ls nope" });
      expect(ng.isError).toBe(false);
      expect(ng.details.exitCode).toBe(2);
      expect(text(ng)).toContain("--- stdout ---\n（なし）");
    });

    test("作業ディレクトリで実行する", async () => {
      expect(text(await call("bash", { command: "pwd" }))).toContain("/workspace");
    });

    test("時間の上限で打ち切り、そのことを示す", async () => {
      const started = performance.now();
      const result = await call("bash", {
        command: "echo start; sleep 30 & sleep 30",
        timeout_seconds: 1,
      });
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        timedOut: true,
        timeoutSeconds: 1,
        error: "timed_out",
      });
      expect(text(result)).toContain("時間の上限（1秒）を超えたため打ち切りました");
      expect(text(result)).toContain("start");
    });

    test("指定した上限は bash_max_timeout_seconds に丸める", async () => {
      const result = await call("bash", { command: "true", timeout_seconds: 9999 });
      expect(result.details.timeoutSeconds).toBe(20);
    });

    test("不正な UTF-8 の出力は置換文字にする", async () => {
      expect(text(await call("bash", { command: "printf 'a\\377b'" }))).toContain("a�b");
    });
  });

  test("ツール1回が1秒以内（SC-004）", async () => {
    const calls: [string, unknown][] = [
      ["read_file", { path: "src/a.ts" }],
      ["write_file", { path: "perf.txt", content: "x" }],
      ["edit_file", { path: "perf.txt", old_string: "x", new_string: "y" }],
      ["bash", { command: "true" }],
    ];
    for (const [name, params] of calls) {
      const started = performance.now();
      const result = await call(name, params);
      expect(result.isError).toBe(false);
      expect(performance.now() - started, name).toBeLessThan(1000);
    }
  });

  test("検査（層3）と合わせると、リンク経由の禁止パスへの書き込みを止める（SC-003）", async () => {
    await call("bash", {
      command: "mkdir -p .github/workflows && ln -sf .github/workflows/new.yml wf.yml",
    });
    const guard = composeGuards(
      {
        name: "path",
        guard: createPathGuard({
          denyWritePaths: DEFAULT_DENY_WRITE_PATHS,
          resolveRealPath: (path) => sandbox.realpath(path),
        }),
      },
      { name: "command", guard: createCommandGuard() },
    );
    const decision = await guard({
      toolName: "write_file",
      args: { path: "wf.yml", content: "on: push" },
    });
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("実際のパスは .github/workflows/new.yml");
    expect(
      await guard({ toolName: "write_file", args: { path: "src/ok.ts", content: "" } }),
    ).toBeUndefined();
    expect((await guard({ toolName: "bash", args: { command: "git push" } }))?.guard).toBe(
      "command",
    );
  });

  test("片付け後はエラーの結果（sandbox_unavailable）を返し、例外にしない", async () => {
    const own = await makeWorkspace();
    const s = await createSandbox({
      jobId: nextJobId++,
      workspace: own.path,
      sandbox: testSandboxConfig(),
    });
    const [read, , , bash] = createTools(s, testToolsConfig());
    await s.destroy();
    for (const [tool, params] of [
      [read, { path: "README.md" }],
      [bash, { command: "true" }],
    ] as const) {
      const result = await tool?.execute("t", params);
      expect(result?.isError).toBe(true);
      expect(result?.details.error).toBe("sandbox_unavailable");
    }
    own.cleanup();
  });
});
