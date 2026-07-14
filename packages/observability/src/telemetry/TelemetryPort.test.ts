import { describe, expect, it } from "vitest";
import { createTelemetryRecord } from "./createTelemetryRecord.js";
import type { ObservabilityRecordContext } from "../ObservabilityRecordContext.js";
import type { TelemetryPort } from "./TelemetryPort.js";
import type { TelemetryRecord } from "./TelemetryRecord.js";

describe("TelemetryPort", () => {
  it("creates telemetry records with operational fields", () => {
    const record = createTelemetryRecord({
      id: "telemetry_001",
      taskId: "task_001",
      eventName: "task.completed",
      timestamp: "2026-06-12T00:00:00.000Z",
      durationMs: 42,
      counters: {
        toolCalls: 2,
      },
      dimensions: {
        status: "succeeded",
        permissionMode: "trusted",
      },
    });

    expect(record).toMatchObject({
      id: "telemetry_001",
      durationMs: 42,
      counters: {
        toolCalls: 2,
      },
      metadata: {},
    });
  });

  it("rejects non-finite counter values", () => {
    expect(() => createTelemetryRecord({
      id: "telemetry_001",
      eventName: "task.completed",
      timestamp: "2026-06-12T00:00:00.000Z",
      counters: {
        duration: Number.NaN,
      },
    })).toThrow("must be a finite number");
  });

  it("records entries through fake telemetry port", async () => {
    const port = new FakeTelemetryPort();
    const record = createTelemetryRecord({
      id: "telemetry_001",
      eventName: "task.completed",
      timestamp: "2026-06-12T00:00:00.000Z",
    });

    await port.record(record, runtimeContext());

    expect(port.records).toEqual([record]);
  });

  it("can simulate telemetry port failure", async () => {
    const port = new FakeTelemetryPort(() => {
      throw new Error("Telemetry backend failed.");
    });

    await expect(port.record(createTelemetryRecord({
      id: "telemetry_001",
      eventName: "task.failed",
      timestamp: "2026-06-12T00:00:00.000Z",
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
