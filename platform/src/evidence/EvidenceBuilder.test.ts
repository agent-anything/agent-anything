import { describe, expect, it } from "vitest";
import type { ToolResult } from "../tools/index.js";
import { EvidenceBuilder } from "./EvidenceBuilder.js";

describe("EvidenceBuilder", () => {
  it("builds evidence from a successful tool result", () => {
    const builder = new EvidenceBuilder();

    const evidence = builder.buildFromToolResult({
      toolResult: createSuccessfulToolResult(),
    });

    expect(evidence).toEqual([
      {
        id: "evidence_tool_call_001",
        source: {
          kind: "toolResult",
          toolCallId: "tool_call_001",
          toolName: "net.lookupDns",
          metadata: {
            adapter: "fake",
          },
        },
        summary: "Evidence from net.lookupDns.",
        content: {
          records: ["93.184.216.34"],
        },
        sensitivity: "normal",
        metadata: {
          createdFrom: "tool_call_001",
        },
      },
    ]);
  });

  it("preserves source metadata", () => {
    const builder = new EvidenceBuilder();

    const [evidence] = builder.buildFromToolResult({
      toolResult: createSuccessfulToolResult(),
    });

    expect(evidence?.source.metadata).toEqual({
      adapter: "fake",
    });
  });

  it("does not create misleading evidence for failed tool results", () => {
    const builder = new EvidenceBuilder();

    const evidence = builder.buildFromToolResult({
      toolResult: {
        ...createSuccessfulToolResult(),
        status: "failed",
        output: null,
        error: {
          code: "dns_failed",
          message: "DNS lookup failed.",
        },
      },
    });

    expect(evidence).toEqual([]);
  });

  it("marks sensitivity from tool result metadata", () => {
    const builder = new EvidenceBuilder();

    const [evidence] = builder.buildFromToolResult({
      toolResult: {
        ...createSuccessfulToolResult(),
        metadata: {
          sensitivity: "sensitive",
        },
      },
    });

    expect(evidence?.sensitivity).toBe("sensitive");
  });

  it("produces stable evidence references", () => {
    const builder = new EvidenceBuilder();

    const [evidence] = builder.buildFromToolResult({
      toolResult: createSuccessfulToolResult(),
    });

    expect(evidence?.id).toBe("evidence_tool_call_001");
  });
});

function createSuccessfulToolResult(): ToolResult {
  return {
    toolCallId: "tool_call_001",
    toolName: "net.lookupDns",
    status: "succeeded",
    output: {
      records: ["93.184.216.34"],
    },
    error: null,
    startedAt: "2026-06-04T00:00:00.000Z",
    finishedAt: "2026-06-04T00:00:01.000Z",
    metadata: {
      adapter: "fake",
    },
  };
}
