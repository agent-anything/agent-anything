import type { IdentityRef, RunWorkspace } from "@agent-anything/agent-core/run";
import type { PlanLimits } from "../plan/index.js";
import type { RetryPolicy } from "../retry/index.js";
import type { CancellationLimits, RunCancellationController } from "../run/index.js";
import type { ResolvedRunPermissionConfig } from "../run/index.js";
import type {
  ToolActionBindingSnapshot,
} from "@agent-anything/action-execution/registration";
import type {
  RunActionContext,
  RunActionContextInput,
} from "@agent-anything/action-execution/enforcement";

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
  readonly toolBindings: ToolActionBindingSnapshot;
  readonly limits: RunLimits;
  readonly audit: RunInfrastructureRequirement;
  readonly telemetry: RunInfrastructureRequirement;
  readonly cancellationLimits: CancellationLimits;
  readonly retry: ResolvedRunRetryConfiguration;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ValidatedRunConfig extends Omit<RunConfig, "actionContext"> {
  readonly actionContext: RunActionContext | null;
}

export interface ResolvedRunConfig extends ValidatedRunConfig {
  readonly cancellation: RunCancellationController;
}
