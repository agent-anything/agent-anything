import type { IdentityRef } from "@agent-anything/agent-core/run";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import type { SandboxEnforcement } from "@agent-anything/action-execution/sandbox";
import type {
  CanonicalActorIdentity,
  CanonicalEnvironmentIdentity,
  CanonicalWorkspaceIdentity,
} from "@agent-anything/canonical-action/subject";
import type { ToolSelectionRevision } from "@agent-anything/tools/selection";
import type { PlanLimits } from "../plan/index.js";
import type { RetryPolicy } from "../retry/index.js";
import type { CancellationLimits, RunCancellationController } from "../run/index.js";
import type { ResolvedRunPermissionConfig } from "../run/index.js";
import type { CompletionGateConfiguration } from "@agent-anything/validation/completion";
import type { ValidationProfile } from "@agent-anything/validation/definition";

export type RunInfrastructureRequirement = "optional" | "required";

export interface RunLimits {
  readonly maxIterations: number;
  readonly maxActions: number;
  readonly maxConsecutiveActionFailures: number;
  readonly maxDurationMs: number;
  readonly maxPendingInteractions: number;
  readonly plan: PlanLimits;
}

export interface RunTreeLimits {
  readonly maxTotalDescendantRuns: number;
  readonly maxActiveDescendantRuns: number;
  readonly maxDescendantDepth: number;
}

export interface ResolvedRunRetryConfiguration {
  readonly providerRequest: RetryPolicy<string>;
  readonly structuredOutput: RetryPolicy<string>;
  readonly action: {
    readonly maxAttempts: number;
  };
}

export interface RunActionExecutionConfig {
  readonly policySnapshotId: string;
  readonly securityContext: {
    readonly workspace: CanonicalWorkspaceIdentity | null;
    readonly actor: CanonicalActorIdentity;
    readonly environment: CanonicalEnvironmentIdentity;
  };
  readonly enforcement: SandboxEnforcement;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RunValidationConfig {
  readonly profile: ValidationProfile;
  readonly completion: CompletionGateConfiguration;
}

export interface RunConfig {
  readonly workspace: WorkspaceSelection | null;
  readonly identity: IdentityRef;
  readonly permissions: ResolvedRunPermissionConfig;
  readonly tools: ToolSelectionRevision;
  readonly actionExecution: RunActionExecutionConfig | null;
  readonly validation: RunValidationConfig;
  readonly limits: RunLimits;
  readonly audit: RunInfrastructureRequirement;
  readonly telemetry: RunInfrastructureRequirement;
  readonly cancellationLimits: CancellationLimits;
  readonly retry: ResolvedRunRetryConfiguration;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RootRunConfig extends RunConfig {
  readonly runTreeLimits: RunTreeLimits;
}

export type ValidatedRunConfig = RunConfig;
export type ValidatedRootRunConfig = RootRunConfig;

export interface ResolvedRunConfig extends RunConfig {
  readonly cancellation: RunCancellationController;
}
