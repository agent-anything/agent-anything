export {
  openDiagnosisPanel,
  type NetDoctorDiagnosisResult,
  type RunNetDoctorDiagnosis,
} from "./DiagnosisPanel.js";
export {
  createNetDoctorReportViewModel,
  type NetDoctorReportCheck,
  type NetDoctorReportViewModel,
} from "./NetDoctorReportViewModel.js";
export { openReportPanel } from "./ReportPanel.js";
export { renderReportHtml } from "./renderReportHtml.js";
export { reportStyles } from "./reportStyles.js";
export {
  ReportTemplateRegistry,
  ReportTemplateRenderer,
  netDoctorSummaryTemplate,
  networkEvidenceTemplate,
  type NetDoctorReport,
  type NetDoctorReportSection,
  type ReportTemplate,
  type ReportTemplateOutput,
  type TemplateRenderInput,
  type TemplateRenderResult,
} from "./templates/index.js";
