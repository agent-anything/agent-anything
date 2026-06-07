import type { Metadata } from "../shared/types.js";

export interface ProviderCapabilities {
  id: string;
  name: string;
  supportsToolPlanning: boolean;
  supportsStructuredOutput: boolean;
  supportsStreaming: boolean;
  metadata: Metadata;
}
