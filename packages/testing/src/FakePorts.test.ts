import { describe, expect, it } from "vitest";
import { FakeAuditPort } from "./FakeAuditPort.js";
import { FakeTelemetryPort } from "./FakeTelemetryPort.js";

describe("testing fake ports", () => {
  it("records audit and telemetry records", async () => {
    const auditPort = new FakeAuditPort();
    const telemetryPort = new FakeTelemetryPort();
    const context = {
      purpose: "runtime" as const,
      signal: new AbortController().signal,
      deadlineAt: null,
    };

    await auditPort.record({
      id: "audit_001",
      action: "tool.execute",
      outcome: "succeeded",
      subject: null,
      target: { kind: "tool", id: "tool_001", metadata: {} },
      createdAt: "2026-06-15T00:00:00.000Z",
      metadata: {},
    }, context);
    await telemetryPort.record({
      id: "telemetry_001",
      name: "tool.execution",
      createdAt: "2026-06-15T00:00:00.000Z",
      dimensions: {},
      counters: {},
      metadata: {},
    }, context);

    expect(auditPort.records).toHaveLength(1);
    expect(telemetryPort.records).toHaveLength(1);
  });
});
