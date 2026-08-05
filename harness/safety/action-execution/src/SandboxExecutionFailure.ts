

export interface SandboxExecutionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly effectState: "none" | "unknown";
  readonly metadata: Readonly<Record<string, unknown>>;
}
