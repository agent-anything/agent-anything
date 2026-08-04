import type { Metadata } from "@agent-anything/foundation";

export interface SandboxExecutionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly effectState: "none" | "unknown";
  readonly metadata: Readonly<Metadata>;
}
