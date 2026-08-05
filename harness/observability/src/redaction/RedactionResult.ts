

export interface RedactionResult<TValue = unknown> {
  value: TValue;
  redacted: boolean;
  redactions: Redaction[];
  metadata: Readonly<Record<string, unknown>>;
}

export interface Redaction {
  path: string;
  ruleId: string;
  reason: string;
}
