import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent.js";
import { mergePreview } from "./useResponsePreview.js";
import { appendOutput } from "../work/CommandOutput.js";

describe("Workbench content", () => {
  it("keeps complete Markdown but rejects remote media and executable markup", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        text={
          '# Result\n\n```cs\nConsole.WriteLine("hello");\n```\n\n![remote](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))'
        }
      />,
    );
    expect(html).toContain("Console.WriteLine");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });
  it("merges preview deltas by identity and offset without duplicating retries", () => {
    const first = {
      runId: "r",
      requestId: "q",
      controllerRequestId: "c",
      invocationId: "a",
      revision: 1,
      state: "receiving",
      code: null,
      parts: [
        {
          id: "p",
          kind: "text" as const,
          name: null,
          text: "hello",
          offset: 0,
          nextOffset: null,
          receivedLength: 5,
          omittedBytes: 0,
          modelItemId: null,
          turnId: null,
          committedRecordId: null,
        },
      ],
    };
    const second = {
      ...first,
      revision: 2,
      parts: [
        { ...first.parts[0]!, text: " world", offset: 5, receivedLength: 11 },
      ],
    };
    expect(mergePreview(first, second).parts[0]?.text).toBe("hello world");
    expect(
      mergePreview(mergePreview(first, second), second).parts[0]?.text,
    ).toBe("hello world");
    expect(
      mergePreview(mergePreview(first, second), { ...first, revision: 2 })
        .parts[0]?.text,
    ).toBe("hello world");
    expect(mergePreview(second, first).revision).toBe(2);
  });
  it("bounds mounted output without breaking multibyte text", () => {
    const result = appendOutput("x".repeat(512 * 1024), "\u4e2d\u6587");
    expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(
      512 * 1024,
    );
    expect(result.text.endsWith("\u4e2d\u6587")).toBe(true);
    expect(result.trimmed).toBe(true);
  });
});
