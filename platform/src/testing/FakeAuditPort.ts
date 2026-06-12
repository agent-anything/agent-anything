import type { AuditPort, AuditRecord } from "../audit/index.js";

export type FakeAuditPortHandler = (
  record: AuditRecord,
) => void | Promise<void>;

export class FakeAuditPort implements AuditPort {
  readonly records: AuditRecord[] = [];

  constructor(
    private readonly handler?: FakeAuditPortHandler,
  ) {}

  async record(record: AuditRecord): Promise<void> {
    await this.handler?.(record);
    this.records.push(record);
  }
}
