import type { Metadata } from "@agent-anything/shared";

export interface ProviderDescriptor {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
  requestRetryScheduler: RetrySchedulerOwnership;
  metadata: Metadata;
}

export type RetrySchedulerOwnership =
  | { readonly kind: "platform" }
  | {
      readonly kind: "sdk";
      readonly sdkName: string;
      readonly maxRetries: number;
      readonly exposesAttemptEvents: boolean;
      readonly supportsCancellation: boolean;
    };

export interface ProviderCapabilities {
  supportsToolPlanning: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
}
