import type { AuditRecord } from "./AuditRecord.js";

export interface AuditPort {
  record(record: AuditRecord): Promise<void>;
}
