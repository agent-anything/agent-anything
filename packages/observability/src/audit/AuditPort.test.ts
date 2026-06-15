import { describe, expect, it } from "vitest";
import type { AuditPort } from "./AuditPort.js";
import type { AuditRecord } from "./AuditRecord.js";
import { createAuditRecord } from "./createAuditRecord.js";

describe("AuditPort", () => {
  it("creates structured audit records", () => {
    const record = createAuditRecord({
      id: "audit_001",
      taskId: "task_001",
      eventName: "tool.finished",
      timestamp: "2026-06-12T00:00:00.000Z",
      actorRef: "user_001",
      workspaceId: "workspace_001",
      subject: {
        kind: "user",
        id: "user_001",
        metadata: {},
      },
      action: "tool.execute",
      target: {
        kind: "tool",
        id: "net.lookupDns",
        metadata: {},
      },
      outcome: "succeeded",
      payload: {
        evidenceRefs: ["evidence_001"],
      },
    });

    expect(record).toMatchObject({
      id: "audit_001",
      actorRef: "user_001",
      workspaceId: "workspace_001",
      outcome: "succeeded",
      metadata: {},
    });
  });

  it("records entries through fake audit port", async () => {
    const port = new FakeAuditPort();
    const record = createAuditRecord({
      id: "audit_001",
      taskId: "task_001",
      eventName: "task.completed",
      timestamp: "2026-06-12T00:00:00.000Z",
      subject: {
        kind: "system",
        id: "system",
        metadata: {},
      },
      action: "runtime.complete",
      target: {
        kind: "task",
        id: "task_001",
        metadata: {},
      },
      outcome: "succeeded",
    });

    await port.record(record);

    expect(port.records).toEqual([record]);
  });

  it("can simulate audit port failure", async () => {
    const port = new FakeAuditPort(() => {
      throw new Error("Audit storage failed.");
    });

    await expect(port.record(createAuditRecord({
      id: "audit_001",
      taskId: "task_001",
      eventName: "task.failed",
      timestamp: "2026-06-12T00:00:00.000Z",
      subject: {
        kind: "system",
        id: "system",
        metadata: {},
      },
      action: "runtime.fail",
      target: {
        kind: "task",
        id: "task_001",
        metadata: {},
      },
      outcome: "failed",
    }))).rejects.toThrow("Audit storage failed.");
  });
});

class FakeAuditPort implements AuditPort {
  readonly records: AuditRecord[] = [];

  constructor(private readonly onRecord?: (record: AuditRecord) => void) {}

  async record(record: AuditRecord): Promise<void> {
    this.onRecord?.(record);
    this.records.push(record);
  }
}
