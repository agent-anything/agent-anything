import type {
  CreateTelemetryRecordInput,
  TelemetryRecord,
} from "./TelemetryRecord.js";

export function createTelemetryRecord(
  input: CreateTelemetryRecordInput,
): TelemetryRecord {
  validateCounters(input.counters ?? {});

  return {
    id: input.id,
    taskId: input.taskId ?? null,
    eventName: input.eventName,
    timestamp: input.timestamp,
    durationMs: input.durationMs ?? null,
    counters: input.counters ?? {},
    dimensions: input.dimensions ?? {},
    metadata: input.metadata ?? {},
  };
}

function validateCounters(counters: Record<string, number>): void {
  for (const [key, value] of Object.entries(counters)) {
    if (!Number.isFinite(value)) {
      throw new Error(`Telemetry counter '${key}' must be a finite number.`);
    }
  }
}
