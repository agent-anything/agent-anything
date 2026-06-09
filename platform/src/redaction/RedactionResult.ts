import type { Metadata } from "../shared/types.js";

export interface RedactionResult<TValue = unknown> {
  value: TValue;
  redacted: boolean;
  redactions: Redaction[];
  metadata: Metadata;
}

export interface Redaction {
  path: string;
  ruleId: string;
  reason: string;
}
