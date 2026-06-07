import { describe, expect, it } from "vitest";
import type { ToolResult } from "@agent-anything/platform";
import { NetDoctorEvidenceBuilder } from "./NetDoctorEvidenceBuilder.js";

describe("NetDoctorEvidenceBuilder", () => {
  it("maps DNS lookup output into readable evidence", () => {
    const evidence = buildEvidence({
      toolName: "netDoctor.dnsLookup",
      output: {
        host: "example.com",
        addresses: [
          {
            address: "93.184.216.34",
            family: 4,
          },
        ],
      },
    });

    expect(evidence).toMatchObject({
      id: "evidence_tool_call_001",
      summary: "example.com resolved to 1 address.",
      sensitivity: "public",
      metadata: {
        evidenceKind: "dnsLookup",
      },
    });
  });

  it("maps failed TCP connectivity into diagnostic evidence", () => {
    const evidence = buildEvidence({
      toolName: "netDoctor.tcpConnect",
      output: {
        host: "example.com",
        port: 443,
        reachable: false,
        timeoutMs: 3000,
      },
    });

    expect(evidence).toMatchObject({
      summary: "TCP example.com:443 did not connect within 3000ms.",
      content: {
        reachable: false,
      },
      sensitivity: "public",
    });
  });

  it("maps HTTP reachability into diagnostic evidence", () => {
    const evidence = buildEvidence({
      toolName: "netDoctor.httpReachability",
      output: {
        url: "https://example.com/",
        reachable: true,
        statusCode: 200,
        statusMessage: "OK",
        timeoutMs: 5000,
      },
    });

    expect(evidence).toMatchObject({
      summary: "https://example.com/ is reachable (HTTP 200 OK).",
      metadata: {
        evidenceKind: "httpReachability",
      },
    });
  });

  it("marks configured proxy evidence as private without exposing values", () => {
    const evidence = buildEvidence({
      toolName: "netDoctor.proxyConfig",
      output: {
        hasProxy: true,
        variables: [
          {
            name: "HTTPS_PROXY",
            configured: true,
          },
          {
            name: "NO_PROXY",
            configured: false,
          },
        ],
      },
    });

    expect(evidence).toMatchObject({
      summary: "Proxy environment configuration is present (HTTPS_PROXY).",
      sensitivity: "private",
      content: {
        variables: [
          {
            name: "HTTPS_PROXY",
            configured: true,
          },
          {
            name: "NO_PROXY",
            configured: false,
          },
        ],
      },
    });
    expect(evidence.summary).not.toContain("http://");
  });

  it("does not create evidence from failed tool results", () => {
    const builder = new NetDoctorEvidenceBuilder();
    const evidence = builder.buildFromToolResult({
      toolResult: {
        ...createToolResult("netDoctor.dnsLookup", null),
        status: "failed",
        error: {
          code: "dns_lookup_failed",
          message: "getaddrinfo ENOTFOUND example.invalid",
        },
      },
    });

    expect(evidence).toEqual([]);
  });
});

function buildEvidence(input: {
  toolName: string;
  output: unknown;
}) {
  const builder = new NetDoctorEvidenceBuilder();
  const evidence = builder.buildFromToolResult({
    toolResult: createToolResult(input.toolName, input.output),
  });

  expect(evidence).toHaveLength(1);
  return evidence[0];
}

function createToolResult(toolName: string, output: unknown): ToolResult {
  return {
    toolCallId: "tool_call_001",
    toolName,
    status: "succeeded",
    output,
    error: null,
    startedAt: "2026-06-05T00:00:00.000Z",
    finishedAt: "2026-06-05T00:00:01.000Z",
    metadata: {
      source: "test",
    },
  };
}
