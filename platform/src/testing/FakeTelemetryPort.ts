import type { TelemetryPort, TelemetryRecord } from "../telemetry/index.js";

export type FakeTelemetryPortHandler = (
  record: TelemetryRecord,
) => void | Promise<void>;

export class FakeTelemetryPort implements TelemetryPort {
  readonly records: TelemetryRecord[] = [];

  constructor(
    private readonly handler?: FakeTelemetryPortHandler,
  ) {}

  async record(record: TelemetryRecord): Promise<void> {
    await this.handler?.(record);
    this.records.push(record);
  }
}
