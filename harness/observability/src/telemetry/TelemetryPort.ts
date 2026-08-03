import type { TelemetryRecord } from "./TelemetryRecord.js";
import type { ObservabilityRecordContext } from "../ObservabilityRecordContext.js";

export interface TelemetryPort {
  record(
    record: TelemetryRecord,
    context: ObservabilityRecordContext,
  ): Promise<void>;
}
