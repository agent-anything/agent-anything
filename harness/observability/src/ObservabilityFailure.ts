import type { Metadata } from "@agent-anything/foundation";

export interface AuditFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Metadata>;
}

export interface TelemetryFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Metadata>;
}
