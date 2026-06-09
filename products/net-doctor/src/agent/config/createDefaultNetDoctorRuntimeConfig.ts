import { defaultRuntimeLimits } from "@agent-anything/platform";
import type { NetDoctorRuntimeConfig } from "./NetDoctorRuntimeConfig.js";

export function createDefaultNetDoctorRuntimeConfig(): NetDoctorRuntimeConfig {
  return {
    providerId: "fake",
    model: "fake-net-doctor-planner",
    providerTimeoutMs: 30000,
    limits: {
      ...defaultRuntimeLimits,
    },
    permissionMode: "allowAll",
    metadata: {
      product: "net-doctor",
      runtime: "phase2-agent",
    },
    providerMetadata: {},
  };
}
