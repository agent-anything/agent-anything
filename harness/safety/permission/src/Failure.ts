import type { Metadata } from "@agent-anything/foundation";

export interface ApprovalFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Metadata>;
}

export interface PermissionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Metadata>;
}
