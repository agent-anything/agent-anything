import type { Metadata } from "@agent-anything/shared";
import type { ProviderMessage } from "./ProviderMessage.js";

export interface ProviderRequest {
  messages: ProviderMessage[];
  capability: string;
  metadata: Metadata;
}
