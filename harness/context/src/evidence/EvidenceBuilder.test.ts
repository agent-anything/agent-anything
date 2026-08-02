import { describe, expect, it } from "vitest";
import type { ToolResult } from "@agent-anything/tools";
import {
  EvidenceBuilder,
  type EvidenceEligibleToolResult,
} from "./EvidenceBuilder.js";

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
        sensitivity: "restricted",
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

  it("builds Evidence from partial results only with a usability attestation", () => {
    const builder = new EvidenceBuilder();

    const [evidence] = builder.buildFromToolResult({
      toolResult: createPartialToolResult(),
    });

    expect(evidence).toMatchObject({
      summary: "Partial evidence from net.lookupDns.",
      content: {
        records: ["93.184.216.34"],
      },
    });
  });

  it("does not trust sensitivity-like ToolResult metadata", () => {
    const builder = new EvidenceBuilder();

    const [evidence] = builder.buildFromToolResult({
      toolResult: {
        ...createSuccessfulToolResult(),
        metadata: {
          sensitivity: "private",
        },
      },
    });

    expect(evidence?.sensitivity).toBe("restricted");
  });

  it("accepts an explicit trusted sensitivity classification", () => {
    const builder = new EvidenceBuilder();

    const [evidence] = builder.buildFromToolResult({
      toolResult: createSuccessfulToolResult(),
      sensitivity: "public",
    });

    expect(evidence?.sensitivity).toBe("public");
  });

  it("supports an explicit conservative unclassified-material policy", () => {
    const builder = new EvidenceBuilder({ unclassifiedSensitivity: "private" });

    const [evidence] = builder.buildFromToolResult({
      toolResult: createSuccessfulToolResult(),
    });

    expect(evidence?.sensitivity).toBe("private");
    expect(() => new EvidenceBuilder({
      unclassifiedSensitivity: "public",
    } as never)).toThrow(/conservative/);
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
    startedAt: "2026-06-04T00:00:00.000Z",
    finishedAt: "2026-06-04T00:00:01.000Z",
    metadata: {
      adapter: "fake",
    },
  };
}

function createPartialToolResult(): EvidenceEligibleToolResult {
  return {
    toolCallId: "tool_call_001",
    toolName: "net.lookupDns",
    status: "partial",
    output: {
      records: ["93.184.216.34"],
    },
    outputUsability: "validated",
    error: {
      code: "tool_output_incomplete",
      message: "The Tool retained a validated result prefix.",
    },
    startedAt: "2026-06-04T00:00:00.000Z",
    finishedAt: "2026-06-04T00:00:01.000Z",
    metadata: {
      adapter: "fake",
    },
  };
}
