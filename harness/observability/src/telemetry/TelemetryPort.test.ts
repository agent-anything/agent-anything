import { describe, expect, it } from "vitest";
import { createTelemetryRecord } from "./createTelemetryRecord.js";
import type { ObservabilityRecordContext } from "../ObservabilityRecordContext.js";
import type { TelemetryPort } from "./TelemetryPort.js";
import {
  TELEMETRY_RECORD_SCHEMA_VERSION,
  type CreateTelemetryRecordInput,
  type TelemetryRecord,
} from "./TelemetryRecord.js";

describe("TelemetryPort", () => {
  it("creates bounded immutable operational measurements", () => {
    const input = {
      id: "telemetry_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "runner.run.succeeded",
      timestamp: "2026-06-12T00:00:00.000Z",
      durationMs: 42,
      counters: {
        iterations: 2,
        actions: 1,
        items: 5,
        undeclaredCounter: 99,
      },
      dimensions: {
        status: "succeeded",
        agentId: "agent_001",
        rawPrompt: "must-not-cross",
      },
    } as unknown as CreateTelemetryRecordInput<"runner.run.succeeded">;

    const record = createTelemetryRecord(input);

    expect(record).toEqual({
      schemaVersion: TELEMETRY_RECORD_SCHEMA_VERSION,
      id: "telemetry_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "runner.run.succeeded",
      timestamp: "2026-06-12T00:00:00.000Z",
      durationMs: 42,
      counters: {
        iterations: 2,
        actions: 1,
        items: 5,
      },
      dimensions: {
        status: "succeeded",
        agentId: "agent_001",
      },
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.counters)).toBe(true);
    expect(Object.isFrozen(record.dimensions)).toBe(true);
  });

  it("rejects non-finite and event-inconsistent measurements", () => {
    expect(() => createTelemetryRecord({
      id: "telemetry_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "runner.run.failed",
      timestamp: "2026-06-12T00:00:00.000Z",
      durationMs: Number.NaN,
      counters: {
        iterations: 1,
        actions: 1,
        items: 2,
      },
      dimensions: {
        status: "failed",
        agentId: "agent_001",
      },
    })).toThrow("non-negative finite number");

    expect(() => createTelemetryRecord({
      id: "telemetry_002",
      runId: "run_001",
      taskId: "task_001",
      eventName: "runner.sandbox.attempt.started",
      timestamp: "2026-06-12T00:00:00.000Z",
      durationMs: 1 as 0,
      counters: { ordinal: 1 },
      dimensions: {
        phase: "started",
        enforcement: "managed",
        outcome: "started",
      },
    })).toThrow("must be zero");
  });

  it("records entries through a TelemetryPort without rebuilding them", async () => {
    const port = new FakeTelemetryPort();
    const record = createTelemetryRecord({
      id: "telemetry_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "runner.sandbox.attempt.resolved",
      timestamp: "2026-06-12T00:00:01.000Z",
      durationMs: 1_000,
      counters: { ordinal: 1 },
      dimensions: {
        phase: "resolved",
        enforcement: "managed",
        outcome: "executed",
      },
    });

    await port.record(record, runtimeContext());

    expect(port.records).toEqual([record]);
    expect(port.records[0]).toBe(record);
  });

  it("keeps sink failure as a rejected port operation", async () => {
    const port = new FakeTelemetryPort(() => {
      throw new Error("Telemetry backend failed.");
    });

    await expect(port.record(createTelemetryRecord({
      id: "telemetry_001",
      runId: "run_001",
      taskId: "task_001",
      eventName: "runner.approval.resolved",
      timestamp: "2026-06-12T00:00:00.000Z",
      durationMs: null,
      counters: {
        requests: 1,
        consecutiveDeclines: 0,
        consecutiveReviewFailures: 0,
        authorityRecords: 1,
      },
      dimensions: {
        reviewer: "user",
        resolutionKind: "decision",
        decisionKind: "accept",
        applicationKind: "applied",
        code: null,
      },
    }), runtimeContext())).rejects.toThrow("Telemetry backend failed.");
  });
});

class FakeTelemetryPort implements TelemetryPort {
  readonly records: TelemetryRecord[] = [];

  constructor(private readonly onRecord?: (record: TelemetryRecord) => void) {}

  async record(
    record: TelemetryRecord,
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
