import type { AgentTask } from "../../core/task/index.js";
import type { Evidence } from "../../evidence/index.js";
import type { ISODateTimeString, Metadata } from "../../shared/types.js";

export interface TemplateRenderInput {
  templateId: string;
  task: AgentTask;
  evidence: Evidence[];
  reportId: string;
  createdAt: ISODateTimeString;
  finalOutput: unknown;
  metadata: Metadata;
}
