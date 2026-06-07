import { describe, expect, it } from "vitest";
import type { Evidence, RuntimeResult } from "@agent-anything/platform";
import { createNetDoctorReportViewModel } from "./NetDoctorReportViewModel.js";

describe("createNetDoctorReportViewModel", () => {
  it("attaches evidence summaries to checks", () => {
    const model = createNetDoctorReportViewModel({
      taskInput: createTaskInput(),
      result: createRuntimeResult({
        evidenceRefs: ["evidence_dns"],
      }),
      evidence: [
        createEvidence({
          id: "evidence_dns",
          toolName: "netDoctor.dnsLookup",
          evidenceKind: "dnsLookup",
          summary: "example.com resolved to 1 address.",
          content: {
            host: "example.com",
            addresses: [{ address: "93.184.216.34", family: 4 }],
          },
        }),
      ],
    });

    expect(model.checks[0]).toMatchObject({
      toolName: "netDoctor.dnsLookup",
      evidenceId: "evidence_dns",
      summary: "example.com resolved to 1 address.",
    });
  });

  it("creates a TCP-focused conclusion when TCP is unreachable", () => {
    const model = createNetDoctorReportViewModel({
      taskInput: createTaskInput(),
      result: createRuntimeResult({
        evidenceRefs: ["evidence_tcp"],
      }),
      evidence: [
        createEvidence({
          id: "evidence_tcp",
          toolName: "netDoctor.tcpConnect",
          evidenceKind: "tcpConnect",
          summary: "TCP example.com:443 did not connect within 3000ms.",
          content: {
            host: "example.com",
            port: 443,
            reachable: false,
            timeoutMs: 3000,
          },
        }),
      ],
    });

    expect(model.conclusion).toContain("TCP connectivity did not complete");
    expect(model.nextSteps).toContain(
      "Verify the target service is listening on the expected port.",
    );
  });

  it("keeps failed runtime conclusions grounded in errors", () => {
    const model = createNetDoctorReportViewModel({
      taskInput: createTaskInput(),
      result: createRuntimeResult({
        status: "failed",
        reportRef: null,
        errors: [
          {
            code: "tool_execution_failed",
            message: "DNS lookup failed.",
            metadata: {},
          },
        ],
      }),
    });

    expect(model.conclusion).toContain("tool_execution_failed");
    expect(model.conclusion).toContain("DNS lookup failed.");
  });
});

function createTaskInput() {
  return {
    target: {
      raw: "example.com",
      normalized: "example.com",
      host: "example.com",
      port: null,
      protocol: null,
    },
    symptom: "Cannot connect",
    toolCalls: [
      {
        toolName: "netDoctor.dnsLookup",
      },
      {
        toolName: "netDoctor.tcpConnect",
      },
    ],
  };
}

function createRuntimeResult(
  overrides: Partial<RuntimeResult> = {},
): RuntimeResult {
  return {
    taskId: "task_001",
    status: "succeeded",
    reportRef: "artifact_report_report_task_001",
    evidenceRefs: [],
    artifactRefs: [],
    errors: [],
    metadata: {},
    ...overrides,
  };
}

function createEvidence(input: {
  id: string;
  toolName: string;
  evidenceKind: string;
  summary: string;
  content: unknown;
  sensitivity?: Evidence["sensitivity"];
}): Evidence {
  return {
    id: input.id,
    source: {
      kind: "toolResult",
      toolCallId: `tool_call_${input.id}`,
      toolName: input.toolName,
      metadata: {},
    },
    summary: input.summary,
    content: input.content,
    sensitivity: input.sensitivity ?? "public",
    metadata: {
      evidenceKind: input.evidenceKind,
    },
  };
}
