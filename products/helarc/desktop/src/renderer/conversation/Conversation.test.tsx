import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent.js";
import { isRepresentedFinal } from "./Conversation.js";
import { appendOutput } from "../execution/CommandOutput.js";
import type { HelarcThreadMessageSnapshot } from "../../shared/HelarcDesktopApi.js";
import type { HelarcRunPresentationRecord } from "../../shared/HelarcWorkbench.js";

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
  it("reconciles final answers only through exact model source identity", () => {
    const message: HelarcThreadMessageSnapshot = {
      id: "message",
      sequence: 1,
      role: "assistant",
      createdAt: "2026-09-18T00:00:00Z",
      relatedRunIds: ["run"],
      relatedArtifactIds: [],
      content: "same text",
      outputSource: {
        kind: "model_text",
        turnId: "turn",
        modelItemIds: ["item"],
      },
    };
    const record = {
      content: {
        kind: "assistant_text",
        modelItemId: "item",
        text: "same text",
      },
    } as HelarcRunPresentationRecord;
    expect(isRepresentedFinal(message, [record])).toBe(true);
    expect(
      isRepresentedFinal(
        { ...message, outputSource: { kind: "product_status" } },
        [record],
      ),
    ).toBe(false);
    expect(
      isRepresentedFinal(message, [
        {
          ...record,
          content: { ...record.content, modelItemId: "other" },
        } as HelarcRunPresentationRecord,
      ]),
    ).toBe(false);
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
