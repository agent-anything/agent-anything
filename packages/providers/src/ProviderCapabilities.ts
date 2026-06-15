import type { Metadata } from "@agent-anything/shared";

export interface ProviderCapabilities {
  id: string;
  name: string;
  supportsToolPlanning: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  metadata: Metadata;
}
