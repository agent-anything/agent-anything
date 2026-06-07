import {
  ProviderBackedPlanner,
  type Planner,
  type Provider,
} from "@agent-anything/platform";
import { buildNetDoctorProviderRequest } from "./buildNetDoctorProviderRequest.js";
import { parseNetDoctorProviderResponse } from "./parseNetDoctorProviderResponse.js";

export function createNetDoctorPlanner(provider: Provider): Planner {
  return new ProviderBackedPlanner({
    provider,
    buildRequest: buildNetDoctorProviderRequest,
    parseResponse: parseNetDoctorProviderResponse,
  });
}
