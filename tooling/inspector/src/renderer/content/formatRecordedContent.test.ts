import { describe, expect, it } from "vitest";
import { formatRecordedContent, formatRecordedJson } from "./formatRecordedContent.js";

describe("recorded JSON presentation", () => {
  it("indents nested JSON by default", () => {
    const text = '{"name":"Read","inputSchema":{"type":"object"}}';
    expect(formatRecordedContent(text, "json")).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });

  it("preserves literal values, duplicate keys and their order", () => {
    const text = String.raw`{"id":9007199254740993,"ratio":1e+03,"path":"\u0061","id":2}`;
    expect(formatRecordedContent(text, "json")).toBe(String.raw`{
  "id": 9007199254740993,
  "ratio": 1e+03,
  "path": "\u0061",
  "id": 2
}`);
  });

  it.each(['{"name":', '{"name":"Read",}', ""])("keeps incomplete or invalid content unchanged: %s", (text) => {
    expect(formatRecordedContent(text, "json")).toBe(text);
  });

  it("leaves plain text unchanged even when it contains JSON", () => {
    const text = '{"name":"Read"}';
    expect(formatRecordedContent(text, "plaintext")).toBe(text);
    expect(formatRecordedJson(text)).toEqual({ kind: "formatted", text: '{\n  "name": "Read"\n}' });
  });

  it.each(["plain text", '{"name":', '{"name":"Read",}', ""])("reports unavailable manual formatting without changing the source: %s", (text) => {
    expect(formatRecordedJson(text)).toEqual({ kind: "unavailable", reason: "invalid_json" });
    expect(formatRecordedContent(text, "plaintext")).toBe(text);
  });

  it("retains the existing display limit", () => {
    const text = JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) });
    expect(formatRecordedContent(text, "json")).toBe(text.slice(0, 2 * 1024 * 1024));
    expect(formatRecordedJson(text)).toEqual({ kind: "unavailable", reason: "display_limit" });
  });

  it("keeps compact JSON when indentation would exceed the display limit", () => {
    const text = `[${"0,".repeat(420000)}0]`;
    expect(formatRecordedContent(text, "json")).toBe(text);
    expect(formatRecordedJson(text)).toEqual({ kind: "unavailable", reason: "display_limit" });
  });
});
