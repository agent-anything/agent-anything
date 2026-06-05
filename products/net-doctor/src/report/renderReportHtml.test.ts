import { describe, expect, it } from "vitest";
import type { NetDoctorReportViewModel } from "./NetDoctorReportViewModel.js";
import { renderReportHtml } from "./renderReportHtml.js";

describe("renderReportHtml", () => {
  it("renders successful report", () => {
    const html = renderReportHtml(createModel({ status: "succeeded" }));

    expect(html).toContain("NetDoctor Report");
    expect(html).toContain("succeeded");
    expect(html).toContain("example.com");
    expect(html).toContain("NetDoctor completed the Phase1 diagnosis flow.");
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
    const html = renderReportHtml(createModel({ evidenceRefs: ["evidence_001"] }));

    expect(html).toContain("evidence_001");
  });

  it("does not expose raw metadata by default", () => {
    const html = renderReportHtml(createModel({ artifactRefs: ["artifact_001"] }));

    expect(html).toContain("artifact_001");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("metadata");
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
      },
    ],
    evidenceRefs: [],
    artifactRefs: [],
    reportRef: "artifact_report_report_task_001",
    conclusion: "NetDoctor completed the Phase1 diagnosis flow.",
    nextSteps: ["Review the checks performed."],
    errors: [],
    ...overrides,
  };
}
