import type { Metadata } from "@agent-anything/shared";

export interface ProviderDescriptor {
  id: string;
  name: string;
  capabilities: ProviderCapabilities;
  metadata: Metadata;
}

export interface ProviderCapabilities {
  supportsToolPlanning: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
}
