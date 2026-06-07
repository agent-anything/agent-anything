import type { Metadata } from "../shared/types.js";
import type { ProviderMessage } from "./ProviderMessage.js";

export interface ProviderRequest {
  messages: ProviderMessage[];
  capability: string;
  metadata: Metadata;
}
