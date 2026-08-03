import { describe, expect, it } from "vitest";
import type { ObservabilityRecordContext } from "../ObservabilityRecordContext.js";
import type { AuditPort } from "./AuditPort.js";
import type {
  AuditRecord,
  CreateAuditRecordInput,
} from "./AuditRecord.js";
import {
  AUDIT_RECORD_SCHEMA_VERSION,
} from "./AuditRecord.js";
import { createAuditRecord } from "./createAuditRecord.js";

describe("AuditPort", () => {
  it("creates a versioned immutable Run-scoped record", () => {
    const optionIds = ["accept", "decline"];
    const input = {
      id: "audit_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "approval.requested",
      timestamp: "2026-06-12T00:00:00.000Z",
      actor: { kind: "user", id: "user_001" },
      workspaceId: "workspace_001",
      subject: { kind: "user", id: "user_001" },
      action: "approval.requested",
      target: {
        kind: "approval_request",
        id: "approval_001",
        actionId: "action_001",
        category: "fileChange",
      },
      outcome: "succeeded",
      payload: {
        pendingVersion: 1,
        optionIds,
        undeclaredSecret: "must-not-cross",
      },
    } as unknown as CreateAuditRecordInput<"approval.requested">;

    const record = createAuditRecord(input);
    optionIds.push("cancel");

    expect(record).toEqual({
      schemaVersion: AUDIT_RECORD_SCHEMA_VERSION,
      id: "audit_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "approval.requested",
      timestamp: "2026-06-12T00:00:00.000Z",
      actor: { kind: "user", id: "user_001" },
      workspaceId: "workspace_001",
      subject: { kind: "user", id: "user_001" },
      action: "approval.requested",
      target: {
        kind: "approval_request",
        id: "approval_001",
        actionId: "action_001",
        category: "fileChange",
      },
      outcome: "succeeded",
      payload: {
        pendingVersion: 1,
        optionIds: ["accept", "decline"],
      },
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.actor)).toBe(true);
    expect(Object.isFrozen(record.target)).toBe(true);
    expect(Object.isFrozen(record.payload)).toBe(true);
    expect(Object.isFrozen(record.payload.optionIds)).toBe(true);
  });

  it("rejects contradictory Run target correlation", () => {
    expect(() => createAuditRecord({
      id: "audit_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "run.failed",
      timestamp: "2026-06-12T00:00:00.000Z",
      actor: { kind: "service", id: "service_001" },
      workspaceId: null,
      subject: { kind: "service", id: "service_001" },
      action: "runner.failed",
      target: { kind: "run", id: "run_other" },
      outcome: "failed",
      payload: {
        status: "failed",
        activeAgentId: "agent_001",
        iterations: 1,
        actions: 0,
        itemCount: 2,
      },
    })).toThrow("must match AuditRecord.runId");
  });

  it("records entries through an AuditPort without rebuilding them", async () => {
    const port = new FakeAuditPort();
    const record = createAuditRecord({
      id: "audit_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "run.succeeded",
      timestamp: "2026-06-12T00:00:00.000Z",
      actor: { kind: "anonymous", id: "anonymous" },
      workspaceId: null,
      subject: { kind: "anonymous", id: "anonymous" },
      action: "runner.succeeded",
      target: { kind: "run", id: "run_001" },
      outcome: "succeeded",
      payload: {
        status: "succeeded",
        activeAgentId: "agent_001",
        iterations: 1,
        actions: 0,
        itemCount: 2,
      },
    });

    await port.record(record, runtimeContext());

    expect(port.records).toEqual([record]);
    expect(port.records[0]).toBe(record);
  });

  it("keeps sink failure as a rejected port operation", async () => {
    const port = new FakeAuditPort(() => {
      throw new Error("Audit storage failed.");
    });

    await expect(port.record(createAuditRecord({
      id: "audit_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "run.failed",
      timestamp: "2026-06-12T00:00:00.000Z",
      actor: { kind: "service", id: "service_001" },
      workspaceId: null,
      subject: { kind: "service", id: "service_001" },
      action: "runner.failed",
      target: { kind: "run", id: "run_001" },
      outcome: "failed",
      payload: {
        status: "failed",
        activeAgentId: "agent_001",
        iterations: 1,
        actions: 1,
        itemCount: 3,
      },
    }), runtimeContext())).rejects.toThrow("Audit storage failed.");
  });
});

class FakeAuditPort implements AuditPort {
  readonly records: AuditRecord[] = [];

  constructor(private readonly onRecord?: (record: AuditRecord) => void) {}

  async record(
    record: AuditRecord,
    _context: ObservabilityRecordContext,
  ): Promise<void> {
    this.onRecord?.(record);
    this.records.push(record);
  }
}

function runtimeContext(): ObservabilityRecordContext {
  return {
    purpose: "runtime",
    signal: new AbortController().signal,
    deadlineAt: null,
  };
}
