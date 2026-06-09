import type {
  Metadata,
  PermissionMode,
  RuntimeLimits,
} from "@agent-anything/platform";

export interface NetDoctorRuntimeConfig {
  providerId: string;
  model: string;
  providerTimeoutMs: number;
  limits: RuntimeLimits;
  permissionMode: PermissionMode;
  metadata: Metadata;
  providerMetadata: Metadata;
}

export interface ResolveNetDoctorRuntimeConfigInput {
  providerId?: string;
  model?: string;
  providerTimeoutMs?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxConsecutiveFailures?: number;
  maxIterations?: number;
  permissionMode?: PermissionMode;
  metadata?: Metadata;
  providerMetadata?: Metadata;
}
