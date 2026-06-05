import { describe, expect, it } from "vitest";
import type { AgentTask } from "../core/task/index.js";
import type { Evidence } from "../evidence/index.js";
import { ReportGenerator } from "./ReportGenerator.js";

describe("ReportGenerator", () => {
  it("generates a report from task metadata and evidence refs", () => {
    const generator = new ReportGenerator();

    const report = generator.generate({
      task: createTask(),
      evidence: [createEvidence()],
      createdAt: "2026-06-04T00:00:00.000Z",
    });

    expect(report).toEqual({
      id: "report_task_001",
      taskId: "task_001",
      title: "Report for net-doctor.diagnose",
      sections: [
        {
          title: "Evidence",
          content: "example.com resolves to one A record.",
          evidenceRefs: ["evidence_001"],
        },
      ],
      evidenceRefs: ["evidence_001"],
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        generator: "phase1-default-report-generator",
      },
    });
  });

  it("preserves evidence references", () => {
    const generator = new ReportGenerator();

    const report = generator.generate({
      task: createTask(),
      evidence: [createEvidence()],
    });

    expect(report.evidenceRefs).toEqual(["evidence_001"]);
    expect(report.sections[0]?.evidenceRefs).toEqual(["evidence_001"]);
  });

  it("handles an empty evidence list", () => {
    const generator = new ReportGenerator();

    const report = generator.generate({
      task: createTask(),
      evidence: [],
    });

    expect(report.evidenceRefs).toEqual([]);
    expect(report.sections[0]?.content).toBe("No evidence was produced.");
  });

  it("produces stable structured output", () => {
    const generator = new ReportGenerator();

    const report = generator.generate({
      task: createTask(),
      evidence: [createEvidence()],
      id: "report_custom",
      title: "Custom report",
      createdAt: "2026-06-04T00:00:00.000Z",
      metadata: {
        correlationId: "run_001",
      },
    });

    expect(report).toMatchObject({
      id: "report_custom",
      title: "Custom report",
      metadata: {
        generator: "phase1-default-report-generator",
        correlationId: "run_001",
      },
    });
  });
});

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input: {
      target: "example.com",
    },
    createdAt: "2026-06-04T00:00:00.000Z",
    metadata: {
      source: "test",
    },
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
    sensitivity: "normal",
    metadata: {
      createdFrom: "tool_call_001",
    },
  };
}
