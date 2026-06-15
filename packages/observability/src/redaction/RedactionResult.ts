import type { Metadata } from "@agent-anything/shared";

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
