import type {
  AgentTask,
  ArtifactRef,
  Evidence,
  EvidenceRef,
  ISODateTimeString,
  Metadata,
} from "@agent-anything/platform";

export interface NetDoctorReport {
  id: string;
  taskId: string;
  title: string;
  sections: NetDoctorReportSection[];
  evidenceRefs: EvidenceRef[];
  createdAt: ISODateTimeString;
  metadata: Metadata;
}

export interface NetDoctorReportSection {
  title: string;
  content: string;
  evidenceRefs: ArtifactRef[];
  metadata: Metadata;
}

export interface TemplateRenderInput {
  templateId: string;
  task: AgentTask;
  evidence: Evidence[];
  reportId: string;
  createdAt: ISODateTimeString;
  finalOutput: unknown;
  metadata: Metadata;
}

export interface ReportTemplateOutput {
  title: string;
  sections: NetDoctorReportSection[];
  metadata: Metadata;
}

export interface ReportTemplate {
  id: string;
  render(input: TemplateRenderInput): ReportTemplateOutput | Promise<ReportTemplateOutput>;
}

export type TemplateRenderStatus = "succeeded" | "failed";

export type TemplateRenderResult =
  | TemplateRenderSucceeded
  | TemplateRenderFailed;

export interface TemplateRenderSucceeded {
  status: "succeeded";
  report: NetDoctorReport;
  error: null;
  metadata: Metadata;
}

export interface TemplateRenderFailed {
  status: "failed";
  report: null;
  error: TemplateRenderError;
  metadata: Metadata;
}

export interface TemplateRenderError {
  code: string;
  message: string;
  metadata?: Metadata;
}
