import { describe, expect, it } from "vitest";
import type { AgentTask } from "../../core/task/index.js";
import type { Evidence } from "../../evidence/index.js";
import type { ReportTemplate } from "./ReportTemplate.js";
import { ReportTemplateRegistry } from "./ReportTemplateRegistry.js";
import { ReportTemplateRenderer } from "./ReportTemplateRenderer.js";
import type { TemplateRenderInput } from "./TemplateRenderInput.js";

describe("ReportTemplateRegistry", () => {
  it("registers one template", () => {
    const registry = new ReportTemplateRegistry();
    const template = createTemplate();

    registry.register(template);

    expect(registry.get("generic-summary")).toBe(template);
    expect(registry.has("generic-summary")).toBe(true);
    expect(registry.list()).toEqual([template]);
  });

  it("rejects duplicate template ids", () => {
    const registry = new ReportTemplateRegistry();

    registry.register(createTemplate());

    expect(() => registry.register(createTemplate())).toThrow(
      "Report template 'generic-summary' is already registered.",
    );
  });
});

describe("ReportTemplateRenderer", () => {
  it("renders a complete report from template output", async () => {
    const registry = new ReportTemplateRegistry();
    registry.register(createTemplate());
    const renderer = new ReportTemplateRenderer({ registry });

    const result = await renderer.render(createRenderInput());

    expect(result).toEqual({
      status: "succeeded",
      report: {
        id: "report_task_001",
        taskId: "task_001",
        title: "Generic report for net-doctor.diagnose",
        sections: [
          {
            title: "Summary",
            content: "example.com resolves to one A record.",
            evidenceRefs: ["evidence_001"],
            metadata: {
              templateSection: "summary",
            },
          },
        ],
        evidenceRefs: ["evidence_001"],
        createdAt: "2026-06-07T00:00:00.000Z",
        metadata: {
          renderer: "phase2-report-template-renderer",
          templateId: "generic-summary",
          runId: "run_001",
          templateMetadata: "included",
        },
      },
      error: null,
      metadata: {
        renderer: "phase2-report-template-renderer",
        templateId: "generic-summary",
      },
    });
  });

  it("returns structured failure when template is missing", async () => {
    const renderer = new ReportTemplateRenderer({
      registry: new ReportTemplateRegistry(),
    });

    const result = await renderer.render(createRenderInput());

    expect(result).toEqual({
      status: "failed",
      report: null,
      error: {
        code: "report_template_missing",
        message: "Report template 'generic-summary' was not found.",
        metadata: {
          templateId: "generic-summary",
        },
      },
      metadata: {
        renderer: "phase2-report-template-renderer",
        templateId: "generic-summary",
      },
    });
  });
});

function createTemplate(): ReportTemplate {
  return {
    id: "generic-summary",
    render(input) {
      return {
        title: `Generic report for ${input.task.kind}`,
        sections: [
          {
            title: "Summary",
            content: input.evidence.map((item) => item.summary).join("\n"),
            evidenceRefs: input.evidence.map((item) => item.id),
            metadata: {
              templateSection: "summary",
            },
          },
        ],
        metadata: {
          templateMetadata: "included",
        },
      };
    },
  };
}

function createRenderInput(): TemplateRenderInput {
  return {
    templateId: "generic-summary",
    task: createTask(),
    evidence: [createEvidence()],
    reportId: "report_task_001",
    createdAt: "2026-06-07T00:00:00.000Z",
    finalOutput: {
      conclusion: "Done",
    },
    metadata: {
      runId: "run_001",
    },
  };
}

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input: {
      target: "example.com",
    },
    createdAt: "2026-06-07T00:00:00.000Z",
    metadata: {},
  };
}

function createEvidence(): Evidence {
  return {
    id: "evidence_001",
    source: {
      kind: "toolResult",
      toolCallId: "tool_call_001",
      toolName: "net.lookupDns",
    },
    summary: "example.com resolves to one A record.",
    content: {
      records: ["93.184.216.34"],
    },
    sensitivity: "public",
    metadata: {},
  };
}
