import type { Metadata } from "@agent-anything/shared";
import type { PermissionMode } from "@agent-anything/permission";
import type { RuntimeLimits } from "@agent-anything/agent-core";

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
