import type {
  NetDoctorRuntimeConfig,
  ResolveNetDoctorRuntimeConfigInput,
} from "./NetDoctorRuntimeConfig.js";
import { createDefaultNetDoctorRuntimeConfig } from "./createDefaultNetDoctorRuntimeConfig.js";

export function resolveNetDoctorRuntimeConfig(
  input: ResolveNetDoctorRuntimeConfigInput = {},
): NetDoctorRuntimeConfig {
  const defaults = createDefaultNetDoctorRuntimeConfig();
  const config: NetDoctorRuntimeConfig = {
    providerId: input.providerId ?? defaults.providerId,
    model: input.model ?? defaults.model,
    providerTimeoutMs: input.providerTimeoutMs ?? defaults.providerTimeoutMs,
    limits: {
      maxToolCalls: input.maxToolCalls ?? defaults.limits.maxToolCalls,
      maxDurationMs: input.maxDurationMs ?? defaults.limits.maxDurationMs,
      maxConsecutiveFailures:
        input.maxConsecutiveFailures ?? defaults.limits.maxConsecutiveFailures,
      maxIterations: input.maxIterations ?? defaults.limits.maxIterations,
    },
    permissionMode: input.permissionMode ?? defaults.permissionMode,
    metadata: {
      ...defaults.metadata,
      ...input.metadata,
    },
    providerMetadata: {
      ...defaults.providerMetadata,
      ...input.providerMetadata,
    },
  };

  validateConfig(config);
  return config;
}

function validateConfig(config: NetDoctorRuntimeConfig): void {
  if (config.providerId.trim().length === 0) {
    throw new Error("providerId must not be empty.");
  }

  if (config.model.trim().length === 0) {
    throw new Error("model must not be empty.");
  }

  if (config.providerTimeoutMs <= 0) {
    throw new Error("providerTimeoutMs must be greater than 0.");
  }

  if (config.limits.maxToolCalls < 0) {
    throw new Error("maxToolCalls must be greater than or equal to 0.");
  }

  if (config.limits.maxDurationMs < 0) {
    throw new Error("maxDurationMs must be greater than or equal to 0.");
  }

  if (config.limits.maxConsecutiveFailures < 0) {
    throw new Error("maxConsecutiveFailures must be greater than or equal to 0.");
  }

  if (config.limits.maxIterations < 0) {
    throw new Error("maxIterations must be greater than or equal to 0.");
  }
}
