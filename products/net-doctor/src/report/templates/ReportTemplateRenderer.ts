import type { EvidenceRef } from "@agent-anything/platform";
import type {
  NetDoctorReport,
  ReportTemplateOutput,
  TemplateRenderInput,
  TemplateRenderResult,
} from "./ReportTemplate.js";
import type { ReportTemplateRegistry } from "./ReportTemplateRegistry.js";

export interface ReportTemplateRendererInput {
  registry: ReportTemplateRegistry;
}

export class ReportTemplateRenderer {
  private readonly registry: ReportTemplateRegistry;

  constructor(input: ReportTemplateRendererInput) {
    this.registry = input.registry;
  }

  async render(input: TemplateRenderInput): Promise<TemplateRenderResult> {
    const template = this.registry.get(input.templateId);
    if (!template) {
      return {
        status: "failed",
        report: null,
        error: {
          code: "net_doctor_report_template_missing",
          message: `Report template '${input.templateId}' was not found.`,
          metadata: {
            templateId: input.templateId,
          },
        },
        metadata: {
          renderer: "net-doctor-report-template-renderer",
          templateId: input.templateId,
        },
      };
    }

    const output = await template.render(input);

    return {
      status: "succeeded",
      report: createReport(input, output),
      error: null,
      metadata: {
        renderer: "net-doctor-report-template-renderer",
        templateId: input.templateId,
      },
    };
  }
}

function createReport(
  input: TemplateRenderInput,
  output: ReportTemplateOutput,
): NetDoctorReport {
  const evidenceRefs = collectEvidenceRefs(input);

  return {
    id: input.reportId,
    taskId: input.task.id,
    title: output.title,
    sections: output.sections,
    evidenceRefs,
    createdAt: input.createdAt,
    metadata: {
      renderer: "net-doctor-report-template-renderer",
      templateId: input.templateId,
      ...input.metadata,
      ...output.metadata,
    },
  };
}

function collectEvidenceRefs(input: TemplateRenderInput): EvidenceRef[] {
  return input.evidence.map((evidence) => evidence.id);
}
