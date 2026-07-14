import type { AuditRecord } from "./AuditRecord.js";
import type { ObservabilityRecordContext } from "../ObservabilityRecordContext.js";

export interface AuditPort {
  record(
    record: AuditRecord,
    context: ObservabilityRecordContext,
  ): Promise<void>;
}
