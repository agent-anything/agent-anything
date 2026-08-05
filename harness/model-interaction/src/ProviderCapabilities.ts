

export interface ProviderDescriptor {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
  requestRetryScheduler: RetrySchedulerOwnership;
  metadata: Readonly<Record<string, unknown>>;
}

export type RetrySchedulerOwnership =
  | { readonly kind: "harness" }
  | {
      readonly kind: "sdk";
      readonly sdkName: string;
      readonly maxAttempts: number;
      readonly exposesAttemptEvents: boolean;
      readonly supportsCancellation: boolean;
    };

export interface ProviderCapabilities {
  supportsToolPlanning: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
}
