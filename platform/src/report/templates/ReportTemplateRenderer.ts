import type { EvidenceRef } from "../../shared/types.js";
import type { Report } from "../Report.js";
import type { ReportTemplateOutput } from "./ReportTemplate.js";
import type { ReportTemplateRegistry } from "./ReportTemplateRegistry.js";
import type { TemplateRenderInput } from "./TemplateRenderInput.js";
import type { TemplateRenderResult } from "./TemplateRenderResult.js";

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
          code: "report_template_missing",
          message: `Report template '${input.templateId}' was not found.`,
          metadata: {
            templateId: input.templateId,
          },
        },
        metadata: {
          renderer: "phase2-report-template-renderer",
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
        renderer: "phase2-report-template-renderer",
        templateId: input.templateId,
      },
    };
  }
}

function createReport(
  input: TemplateRenderInput,
  output: ReportTemplateOutput,
): Report {
  const evidenceRefs = collectEvidenceRefs(input);

  return {
    id: input.reportId,
    taskId: input.task.id,
    title: output.title,
    sections: output.sections,
    evidenceRefs,
    createdAt: input.createdAt,
    metadata: {
      renderer: "phase2-report-template-renderer",
      templateId: input.templateId,
      ...input.metadata,
      ...output.metadata,
    },
  };
}

function collectEvidenceRefs(input: TemplateRenderInput): EvidenceRef[] {
  return input.evidence.map((evidence) => evidence.id);
}
