import type {
  ObservabilityRecordContext,
  TelemetryPort,
  TelemetryRecord,
} from "@agent-anything/observability/telemetry";

export type FakeTelemetryPortHandler = (
  record: TelemetryRecord,
  context: ObservabilityRecordContext,
) => void | Promise<void>;

export class FakeTelemetryPort implements TelemetryPort {
  readonly records: TelemetryRecord[] = [];

  constructor(
    private readonly handler?: FakeTelemetryPortHandler,
  ) {}

  async record(
    record: TelemetryRecord,
    context: ObservabilityRecordContext,
  ): Promise<void> {
    await this.handler?.(record, context);
    this.records.push(record);
  }
}
