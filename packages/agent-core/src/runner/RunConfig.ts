import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { Metadata } from "@agent-anything/shared";
import type { PlanLimits } from "../plan/index.js";
import type { RetryPolicy } from "../retry/index.js";
import type {
  CancellationLimits,
  RunCancellationController,
} from "./RunCancellation.js";

export type RunInfrastructureRequirement = "optional" | "required";

export interface RunLimits {
  readonly maxIterations: number;
  readonly maxActions: number;
  readonly maxConsecutiveActionFailures: number;
  readonly maxDurationMs: number;
  readonly plan: PlanLimits;
}

export interface ResolvedRunRetryConfiguration {
  readonly providerRequest: RetryPolicy<string>;
  readonly structuredOutput: RetryPolicy<string>;
}

export interface RunConfig {
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly limits: RunLimits;
  readonly audit: RunInfrastructureRequirement;
  readonly telemetry: RunInfrastructureRequirement;
  readonly cancellation: RunCancellationController;
  readonly cancellationLimits: CancellationLimits;
  readonly retry: ResolvedRunRetryConfiguration;
  readonly metadata: Metadata;
}
