import { defaultRuntimeLimits } from "@agent-anything/agent-core";
import type { NetDoctorRuntimeConfig } from "./NetDoctorRuntimeConfig.js";

export function createDefaultNetDoctorRuntimeConfig(): NetDoctorRuntimeConfig {
  return {
    providerId: "fake",
    model: "fake-net-doctor-planner",
    providerTimeoutMs: 30000,
    limits: {
      ...defaultRuntimeLimits,
    },
    permissionMode: "trusted",
    metadata: {
      product: "net-doctor",
      runtime: "phase2-agent",
    },
    providerMetadata: {},
  };
}
