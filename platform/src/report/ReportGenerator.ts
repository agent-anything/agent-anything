import type { AgentTask } from "../core/task/index.js";
import type { Evidence } from "../evidence/index.js";
import type { Metadata } from "../shared/types.js";
import type { Report } from "./Report.js";

export interface GenerateReportInput {
  task: AgentTask;
  evidence: Evidence[];
  finalOutput?: unknown;
  id?: string;
  title?: string;
  createdAt?: string;
  metadata?: Metadata;
}

export interface ReportGeneratorPort {
  generate(input: GenerateReportInput): Report | Promise<Report>;
}

export class ReportGenerator implements ReportGeneratorPort {
  generate(input: GenerateReportInput): Report {
    const evidenceRefs = input.evidence.map((evidence) => evidence.id);

    return {
      id: input.id ?? createReportId(input.task.id),
      taskId: input.task.id,
      title: input.title ?? createTitle(input.task),
      sections: [
        {
          title: "Evidence",
          content: createEvidenceSummary(input.evidence),
          evidenceRefs,
        },
      ],
      evidenceRefs,
      createdAt: input.createdAt ?? new Date().toISOString(),
      metadata: {
        generator: "phase1-default-report-generator",
        ...input.metadata,
      },
    };
  }
}

function createReportId(taskId: string): string {
  return `report_${taskId}`;
}

function createTitle(task: AgentTask): string {
  return `Report for ${task.kind}`;
}

function createEvidenceSummary(evidence: Evidence[]): string {
  if (evidence.length === 0) {
    return "No evidence was produced.";
  }

  return evidence.map((item) => item.summary).join("\n");
}
