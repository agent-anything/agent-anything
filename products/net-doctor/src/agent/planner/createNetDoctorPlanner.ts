import { ProviderBackedPlanner, type Planner } from "@agent-anything/agent-core";
import type { Provider } from "@agent-anything/providers";
import { buildNetDoctorProviderRequest } from "./buildNetDoctorProviderRequest.js";
import { parseNetDoctorProviderResponse } from "./parseNetDoctorProviderResponse.js";

export function createNetDoctorPlanner(provider: Provider): Planner {
  return new ProviderBackedPlanner({
    provider,
    buildRequest: buildNetDoctorProviderRequest,
    parseResponse: parseNetDoctorProviderResponse,
  });
}
