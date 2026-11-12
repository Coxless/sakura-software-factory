import Type from "typebox";
import { describe, expect, test } from "vitest";
import { extractJsonObject, repairMessage, validate } from "./structured.ts";

describe("extractJsonObject", () => {
  test("素の JSON", () => {
    expect(extractJsonObject('{"a":1,"b":[1,2]}')).toEqual({ a: 1, b: [1, 2] });
  });

  test("```json の囲み", () => {
    expect(extractJsonObject('```json\n{"a": "x"}\n```')).toEqual({ a: "x" });
    expect(extractJsonObject('```\n{"a": "x"}\n```')).toEqual({ a: "x" });
  });

  test("前後に説明文", () => {
    expect(extractJsonObject('はい、計画です。\n{"a": 1}\n以上です。')).toEqual({ a: 1 });
  });

  test("文字列の中の括弧とエスケープした引用符で崩れない", () => {
    const text = '前置き {"a": "}{ \\" }", "b": {"c": "x}"}} 後ろ {"z": 1}';
    expect(extractJsonObject(text)).toEqual({ a: '}{ " }', b: { c: "x}" } });
  });

  test("最初の候補が壊れていれば次の候補を試す", () => {
    expect(extractJsonObject('{壊れた} そして {"a": 2}')).toEqual({ a: 2 });
  });

  test("JSON がない・壊れている・配列だけなら undefined", () => {
    expect(extractJsonObject("JSON はありません")).toBeUndefined();
    expect(extractJsonObject('{"a": ')).toBeUndefined();
    expect(extractJsonObject("[1, 2]")).toBeUndefined();
    expect(extractJsonObject("")).toBeUndefined();
  });
});

describe("validate", () => {
  const Schema = Type.Object({
    summary: Type.String({ minLength: 1 }),
    steps: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    kind: Type.Enum(["a", "b"]),
  });

  test("合えば値を返す。余分な項目は許す", () => {
    const result = validate(Schema, { summary: "s", steps: ["x"], kind: "a", extra: 1 });
    expect(result.ok).toBe(true);
  });

  test("合わなければ「パス: 理由」の一覧", () => {
    const result = validate(Schema, { summary: "", steps: [], kind: "c" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/summary: .*1 文字以上/),
        expect.stringMatching(/^\/steps: .*1 件以上/),
        expect.stringMatching(/^\/kind: .*a, b/),
      ]),
    );
  });

  test("足りない項目", () => {
    const result = validate(Schema, { summary: "s", steps: ["x"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([expect.stringMatching(/^\/kind: .*必須/)]);
  });

  test("オブジェクトでなければ / の誤り", () => {
    const result = validate(Schema, undefined);
    expect(result.ok).toBe(false);
  });
});

describe("repairMessage", () => {
  test("誤りの一覧と、JSON オブジェクトだけを返す指示を含む", () => {
    const text = repairMessage(["/steps: 1 件以上にしてください"]);
    expect(text).toContain("/steps: 1 件以上にしてください");
    expect(text).toContain("JSON オブジェクトだけ");
  });

  test("JSON を取り出せなかったとき", () => {
    expect(repairMessage([])).toContain("JSON オブジェクトを見つけられません");
  });
});
