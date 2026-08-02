import type {
  IdentityRef,
  Metadata,
  RunWorkspace,
} from "@agent-anything/foundation";
import type { PlanLimits } from "@agent-anything/runtime/plan";
import type { RetryPolicy } from "@agent-anything/runtime/retry";
import type {
  CancellationLimits,
  RunCancellationController,
} from "@agent-anything/runtime/run";
import type { ResolvedRunPermissionConfig } from "@agent-anything/runtime/run";
import type { RunActionContext, RunActionContextInput } from "@agent-anything/action-execution";
import type { ToolCatalogSnapshot } from "@agent-anything/tools";

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
  readonly workspace: RunWorkspace | null;
  readonly identity: IdentityRef;
  readonly actionContext: RunActionContextInput | null;
  readonly permissions: ResolvedRunPermissionConfig;
  readonly toolCatalog: ToolCatalogSnapshot;
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
