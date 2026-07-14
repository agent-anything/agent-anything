export type {
  CreateTelemetryRecordInput,
  TelemetryCounters,
  TelemetryDimensions,
  TelemetryDimensionValue,
  TelemetryRecord,
} from "./TelemetryRecord.js";
export type { TelemetryPort } from "./TelemetryPort.js";
export type {
  ObservabilityRecordContext,
  ObservabilityRecordPurpose,
} from "../ObservabilityRecordContext.js";
export { createTelemetryRecord } from "./createTelemetryRecord.js";
