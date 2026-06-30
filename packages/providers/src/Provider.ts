import type { ProviderDescriptor } from "./ProviderCapabilities.js";
import type { ProviderRequest } from "./ProviderRequest.js";
import type { ProviderResponse } from "./ProviderResponse.js";

export interface Provider {
  readonly descriptor: ProviderDescriptor;
  send(request: ProviderRequest): Promise<ProviderResponse>;
}
