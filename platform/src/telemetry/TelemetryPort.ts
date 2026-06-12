import type { TelemetryRecord } from "./TelemetryRecord.js";

export interface TelemetryPort {
  record(record: TelemetryRecord): Promise<void>;
}
