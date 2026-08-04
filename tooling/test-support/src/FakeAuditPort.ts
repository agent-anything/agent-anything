import type {
  AuditPort,
  AuditRecord,
  ObservabilityRecordContext,
} from "@agent-anything/observability/audit";

export type FakeAuditPortHandler = (
  record: AuditRecord,
  context: ObservabilityRecordContext,
) => void | Promise<void>;

export class FakeAuditPort implements AuditPort {
  readonly records: AuditRecord[] = [];

  constructor(
    private readonly handler?: FakeAuditPortHandler,
  ) {}

  async record(
    record: AuditRecord,
    context: ObservabilityRecordContext,
  ): Promise<void> {
    await this.handler?.(record, context);
    this.records.push(record);
  }
}
