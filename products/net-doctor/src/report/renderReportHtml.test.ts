import { describe, expect, it } from "vitest";
import type { NetDoctorReportViewModel } from "./NetDoctorReportViewModel.js";
import { renderReportHtml } from "./renderReportHtml.js";

describe("renderReportHtml", () => {
  it("renders successful report", () => {
    const html = renderReportHtml(createModel({ status: "succeeded" }));

    expect(html).toContain("NetDoctor Report");
    expect(html).toContain("succeeded");
    expect(html).toContain("example.com");
    expect(html).toContain("did not find an obvious DNS, TCP, HTTP, or proxy blocker");
  });

  it("renders failed report", () => {
    const html = renderReportHtml(
      createModel({
        status: "failed",
        errors: [{ code: "tool_execution_failed", message: "DNS failed." }],
      }),
    );

    expect(html).toContain("failed");
    expect(html).toContain("tool_execution_failed");
    expect(html).toContain("DNS failed.");
  });

  it("renders evidence references", () => {
    const html = renderReportHtml(
      createModel({
        evidence: [
          {
            id: "evidence_001",
            toolName: "netDoctor.dnsLookup",
            evidenceKind: "dnsLookup",
            summary: "example.com resolved to 1 address.",
            sensitivity: "normal",
            content: {},
          },
        ],
        evidenceRefs: ["evidence_001"],
      }),
    );

    expect(html).toContain("evidence_001");
    expect(html).toContain("example.com resolved to 1 address.");
  });

  it("does not expose raw metadata by default", () => {
    const html = renderReportHtml(createModel({ artifactRefs: ["artifact_001"] }));

    expect(html).toContain("artifact_001");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("metadata");
  });

  it("does not duplicate the report artifact in the evidence artifact list", () => {
    const html = renderReportHtml(
      createModel({
        reportRef: "artifact_report_report_task_001",
        artifactRefs: [
          "artifact_evidence_evidence_tool_call_dns_lookup",
          "artifact_report_report_task_001",
        ],
      }),
    );

    expect(html).toContain("Report Artifact");
    expect(html).toContain("Evidence Artifacts");
    expect(countOccurrences(html, "artifact_report_report_task_001")).toBe(1);
    expect(html).toContain("artifact_evidence_evidence_tool_call_dns_lookup");
  });
});

function createModel(
  overrides: Partial<NetDoctorReportViewModel> = {},
): NetDoctorReportViewModel {
  return {
    status: "succeeded",
    target: "example.com",
    symptom: "Cannot connect",
    checks: [
      {
        name: "DNS lookup",
        toolName: "netDoctor.dnsLookup",
        evidenceId: null,
        summary: null,
        sensitivity: null,
      },
    ],
    evidence: [],
    evidenceRefs: [],
    artifactRefs: [],
    reportRef: "artifact_report_report_task_001",
    conclusion: "NetDoctor completed the Phase1 diagnosis flow and did not find an obvious DNS, TCP, HTTP, or proxy blocker in the collected evidence.",
    nextSteps: ["Review the checks performed."],
    errors: [],
    ...overrides,
  };
}

function countOccurrences(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}
