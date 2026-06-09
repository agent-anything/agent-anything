export type { Report } from "./Report.js";
export type { ReportSection } from "./ReportSection.js";
export {
  ReportGenerator,
  type GenerateReportInput,
  type ReportGeneratorPort,
} from "./ReportGenerator.js";
export type {
  ReportTemplate,
  ReportTemplateOutput,
  TemplateRenderError,
  TemplateRenderFailed,
  TemplateRenderInput,
  TemplateRenderResult,
  TemplateRenderStatus,
  TemplateRenderSucceeded,
} from "./templates/index.js";
export {
  ReportTemplateRegistry,
  ReportTemplateRenderer,
  type ReportTemplateRendererInput,
} from "./templates/index.js";
