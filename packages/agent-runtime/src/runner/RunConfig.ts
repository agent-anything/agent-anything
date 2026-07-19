import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { Metadata } from "@agent-anything/shared";
import type { PlanLimits } from "@agent-anything/agent-core/plan";
import type { RetryPolicy } from "@agent-anything/agent-core/retry";
import type {
  CancellationLimits,
  RunCancellationController,
} from "@agent-anything/agent-core/run";
import type { ResolvedRunPermissionConfig } from "@agent-anything/agent-core/run";
import type { RunActionContext, RunActionContextInput } from "@agent-anything/agent-core/action-execution";

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
  readonly approvalsReviewer: RetryPolicy<string>;
}

export interface RunConfig {
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly actionContext: RunActionContextInput | null;
  readonly permissions: ResolvedRunPermissionConfig;
  readonly limits: RunLimits;
  readonly audit: RunInfrastructureRequirement;
  readonly telemetry: RunInfrastructureRequirement;
  readonly cancellation: RunCancellationController;
  readonly cancellationLimits: CancellationLimits;
  readonly retry: ResolvedRunRetryConfiguration;
  readonly metadata: Metadata;
}

export interface ResolvedRunConfig extends Omit<RunConfig, "actionContext"> {
  readonly actionContext: RunActionContext | null;
}
