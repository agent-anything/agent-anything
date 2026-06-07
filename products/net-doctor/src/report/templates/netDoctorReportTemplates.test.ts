import {
  ReportTemplateRegistry,
  ReportTemplateRenderer,
  type Evidence,
  type TemplateRenderInput,
} from "@agent-anything/platform";
import { describe, expect, it } from "vitest";
import { netDoctorSummaryTemplate } from "./netDoctorSummaryTemplate.js";
import { networkEvidenceTemplate } from "./networkEvidenceTemplate.js";

describe("NetDoctor report templates", () => {
  it("renders a NetDoctor summary report through the platform renderer", async () => {
    const result = await renderTemplate("net-doctor.summary");

    expect(result).toMatchObject({
      status: "succeeded",
      report: {
        id: "report_task_001",
        taskId: "task_001",
        title: "NetDoctor diagnosis for https://example.com",
        evidenceRefs: ["evidence_dns", "evidence_proxy"],
        sections: [
          {
            title: "Diagnosis",
            evidenceRefs: ["evidence_dns", "evidence_proxy"],
          },
          {
            title: "Evidence Summary",
            evidenceRefs: ["evidence_dns", "evidence_proxy"],
          },
        ],
        metadata: {
          product: "net-doctor",
          template: "summary",
        },
      },
    });
    expect(result.report?.sections[0]?.content).toContain(
      "Conclusion: DNS and proxy checks completed.",
    );
  });

  it("renders network evidence grouped by evidence kind", async () => {
    const result = await renderTemplate("net-doctor.network-evidence");

    expect(result).toMatchObject({
      status: "succeeded",
      report: {
        title: "NetDoctor network evidence for https://example.com",
        sections: [
          {
            title: "DNS lookup evidence",
            evidenceRefs: ["evidence_dns"],
            metadata: {
              evidenceKind: "dnsLookup",
              sensitivities: ["public"],
            },
          },
          {
            title: "Proxy configuration evidence",
            evidenceRefs: ["evidence_proxy"],
            metadata: {
              evidenceKind: "proxyConfig",
              sensitivities: ["private"],
            },
          },
        ],
      },
    });
  });

  it("does not expose raw private evidence content in rendered sections", async () => {
    const result = await renderTemplate("net-doctor.network-evidence");

    const sectionContent = result.report?.sections
      .map((section) => section.content)
      .join("\n");

    expect(sectionContent).toContain("Proxy environment configuration is present.");
    expect(sectionContent).toContain("(private)");
    expect(sectionContent).not.toContain("http://user:password@proxy.local:8080");
  });
});

async function renderTemplate(templateId: string) {
  const registry = new ReportTemplateRegistry();
  registry.register(netDoctorSummaryTemplate);
  registry.register(networkEvidenceTemplate);
  const renderer = new ReportTemplateRenderer({ registry });

  return renderer.render({
    ...createRenderInput(),
    templateId,
  });
}

function createRenderInput(): TemplateRenderInput {
  return {
    templateId: "net-doctor.summary",
    task: {
      id: "task_001",
      kind: "net-doctor.diagnose",
      input: {
        target: {
          raw: "https://example.com",
          host: "example.com",
          port: 443,
          protocol: "https",
          normalized: "https://example.com",
        },
        symptom: "Browser cannot reach the service.",
      },
      createdAt: "2026-06-07T00:00:00.000Z",
      metadata: {},
    },
    evidence: [
      createEvidence({
        id: "evidence_dns",
        evidenceKind: "dnsLookup",
        summary: "example.com resolved to 1 address.",
        sensitivity: "public",
        content: {
          addresses: ["93.184.216.34"],
        },
      }),
      createEvidence({
        id: "evidence_proxy",
        evidenceKind: "proxyConfig",
        summary: "Proxy environment configuration is present.",
        sensitivity: "private",
        content: {
          proxyUrl: "http://user:password@proxy.local:8080",
        },
      }),
    ],
    reportId: "report_task_001",
    createdAt: "2026-06-07T00:00:00.000Z",
    finalOutput: {
      conclusion: "DNS and proxy checks completed.",
    },
    metadata: {},
  };
}

function createEvidence(input: {
  id: string;
  evidenceKind: string;
  summary: string;
  sensitivity: Evidence["sensitivity"];
  content: unknown;
}): Evidence {
  return {
    id: input.id,
    source: {
      kind: "toolResult",
      toolCallId: `tool_call_${input.evidenceKind}`,
      toolName: `netDoctor.${input.evidenceKind}`,
    },
    summary: input.summary,
    content: input.content,
    sensitivity: input.sensitivity,
    metadata: {
      evidenceKind: input.evidenceKind,
    },
  };
}
