import type { ProviderCapabilities } from "./ProviderCapabilities.js";
import type { ProviderRequest } from "./ProviderRequest.js";
import type { ProviderResponse } from "./ProviderResponse.js";

export interface Provider {
  readonly capabilities: ProviderCapabilities;
  send(request: ProviderRequest): Promise<ProviderResponse>;
}
