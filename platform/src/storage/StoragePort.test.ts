import { describe, expect, it } from "vitest";
import type { Evidence } from "../evidence";
import type { Report } from "../report";
import { InMemoryStorage } from "./InMemoryStorage";
import type { StoragePort } from "./StoragePort";

describe("InMemoryStorage", () => {
  it("stores a report artifact", async () => {
    const storage = new InMemoryStorage();

    const artifact = await storage.storeReport(createReport());

    expect(artifact).toMatchObject({
      id: "artifact_report_report_001",
      kind: "report",
      ref: "memory://report/report_001",
      metadata: {
        contentType: "application/json",
        storage: "in-memory",
      },
    });
  });

  it("stores an evidence artifact", async () => {
    const storage = new InMemoryStorage();

    const artifact = await storage.storeEvidence(createEvidence());

    expect(artifact).toMatchObject({
      id: "artifact_evidence_evidence_001",
      kind: "evidence",
      ref: "memory://evidence/evidence_001",
      metadata: {
        contentType: "application/json",
        storage: "in-memory",
      },
    });
  });

  it("returns stable references", async () => {
    const storage = new InMemoryStorage();

    const first = await storage.storeReport(createReport());
    const second = await storage.storeReport(createReport());

    expect(first.id).toBe(second.id);
    expect(first.ref).toBe(second.ref);
  });

  it("reads back artifacts when using in-memory storage", async () => {
    const storage = new InMemoryStorage();

    const artifact = await storage.storeReport(createReport());

    expect(storage.getArtifact(artifact.id)).toMatchObject({
      id: "artifact_report_report_001",
    });
    expect(storage.getReport("report_001")).toMatchObject({
      id: "report_001",
    });
  });

  it("can be replaced through the StoragePort contract", async () => {
    const storage: StoragePort = new InMemoryStorage();

    const artifact = await storage.storeEvidence(createEvidence());

    expect(artifact.kind).toBe("evidence");
  });
});

function createReport(): Report {
  return {
    id: "report_001",
    taskId: "task_001",
    title: "Report for net-doctor.diagnose",
    sections: [],
    evidenceRefs: ["evidence_001"],
    createdAt: "2026-06-04T00:00:00.000Z",
    metadata: {
      generator: "test",
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
