import { describe, expect, it } from "vitest";
import { projectProcessOutputText } from "./ProcessOutputText.js";

describe("projectProcessOutputText", () => {
  it("preserves valid UTF-8 as exact text", () => {
    expect(projectProcessOutputText(Buffer.from("hello \u4e16\u754c", "utf8"))).toEqual({
      text: "hello \u4e16\u754c",
      encoding: "utf-8",
      encodingSource: "utf8",
      integrity: "exact",
      replacementCount: 0,
    });
  });

  it("strictly decodes BOM-declared UTF-16 text", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("ready", "utf16le"),
    ]);

    expect(projectProcessOutputText(bytes)).toEqual({
      text: "ready",
      encoding: "utf-16le",
      encodingSource: "bom",
      integrity: "exact",
      replacementCount: 0,
    });
  });

  it("labels detected legacy text as inferred", () => {
    const windows1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);

    expect(projectProcessOutputText(windows1251)).toEqual({
      text: "\u041f\u0440\u0438\u0432\u0435\u0442",
      encoding: "windows-1251",
      encodingSource: "detected",
      integrity: "inferred",
      replacementCount: 0,
    });
  });

  it("does not present binary output as text", () => {
    expect(projectProcessOutputText(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toEqual({
      text: "",
      encoding: null,
      encodingSource: "none",
      integrity: "unavailable",
      replacementCount: 0,
    });
  });
});
