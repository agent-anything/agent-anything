import type { ISODateTimeString } from "@agent-anything/foundation";

export type ObservabilityRecordPurpose = "runtime" | "finalization";

export interface ObservabilityRecordContext {
  readonly purpose: ObservabilityRecordPurpose;
  readonly signal: AbortSignal;
  readonly deadlineAt: ISODateTimeString | null;
}
