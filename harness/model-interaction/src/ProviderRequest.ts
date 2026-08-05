
import type { ProviderMessage } from "./ProviderMessage.js";

export interface ProviderRequest {
  messages: ProviderMessage[];
  capability: string;
  metadata: Readonly<Record<string, unknown>>;
}
