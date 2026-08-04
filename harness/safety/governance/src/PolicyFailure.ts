import type { Metadata } from "@agent-anything/foundation";

export interface PolicyFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Metadata>;
}
