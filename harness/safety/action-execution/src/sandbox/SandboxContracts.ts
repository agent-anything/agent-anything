import type { InvocationInterruptionContext } from "@agent-anything/agent-core/control";
import type { ActionAttemptRef } from "@agent-anything/canonical-action/subject";
import type { ActionExecutorDescriptor } from "@agent-anything/canonical-action/registration";
import type { PreparedActionInvocation } from "@agent-anything/canonical-action/subject";
import type {
  PhysicalAttemptOutcome,
} from "../execution/ActionExecutor.js";

export type SandboxEnforcement = "managed" | "external" | "disabled";
export type SandboxProviderKind = Exclude<SandboxEnforcement, "disabled">;

export interface ActionExecutionLimits {
  readonly maxResultBytes: number;
}

export interface SandboxAttempt extends ActionAttemptRef {
  readonly runId: string;
  readonly actionFingerprint: string;
  readonly enforcement: SandboxEnforcement;
  readonly policyId: string;
  readonly authoritySnapshotId: string;
  readonly dispatchPlanFingerprint: string;
  readonly actionRegistrationFingerprint: string;
  readonly startedAt: string;
}

export interface SandboxPolicyEnvelope {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly actionFingerprint: string;
  readonly authoritySnapshotId: string;
  readonly enforcement: SandboxEnforcement;
  readonly defaultDisposition: "deny";
  readonly effectFamilies: readonly string[];
  readonly resourceLimits: ActionExecutionLimits;
  readonly allowedSecretReferences: readonly string[];
}

export interface SandboxExecutionRequest {
  readonly attempt: SandboxAttempt;
  readonly policy: SandboxPolicyEnvelope;
  readonly executor: ActionExecutorDescriptor;
  readonly actionRegistrationFingerprint: string;
  readonly invocation: PreparedActionInvocation;
  readonly deadlineAt: string;
  readonly interruption: InvocationInterruptionContext;
}

export interface SandboxCancellationRequest {
  readonly attempt: ActionAttemptRef;
  readonly cancellationId: string;
}

export type SandboxCancellationResult =
  | { readonly status: "accepted" }
  | { readonly status: "already_settled" }
  | { readonly status: "unavailable"; readonly code: string };

export interface SandboxProviderDescriptor {
  readonly id: string;
  readonly version: string;
  readonly kind: SandboxProviderKind;
  readonly supportedPolicyVersions: readonly number[];
  readonly supportedEffectFamilies: readonly string[];
}

export interface SandboxEnforcementEvidence {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly policyId: string;
  readonly enforcement: SandboxEnforcement;
  readonly enforcedEffectFamilies: readonly string[];
  readonly settledAt: string;
}

export type SandboxProviderResult<TPayload = unknown> =
  | {
      readonly status: "settled";
      readonly outcome: PhysicalAttemptOutcome<TPayload>;
      readonly enforcementEvidence: SandboxEnforcementEvidence;
    }
  | {
      readonly status: "enforcement_failed";
      readonly stage: "capability_check" | "setup" | "dispatch" | "settlement";
      readonly code: string;
      readonly effectState: "none" | "unknown";
    };

export interface SandboxProvider<TPayload = unknown> {
  readonly kind: SandboxProviderKind;
  readonly descriptor: SandboxProviderDescriptor;
  execute(input: SandboxExecutionRequest): Promise<SandboxProviderResult<TPayload>>;
  cancel(input: SandboxCancellationRequest): Promise<SandboxCancellationResult>;
}

export type SandboxExecutionResult<TPayload = unknown> =
  | {
      readonly status: "settled";
      readonly attempt: SandboxAttempt;
      readonly outcome: PhysicalAttemptOutcome<TPayload>;
      readonly isolation: "enforced" | "unisolated";
      readonly enforcementEvidence: SandboxEnforcementEvidence;
    }
  | {
      readonly status: "sandbox_unavailable";
      readonly attempt: SandboxAttempt;
      readonly code: string;
      readonly stage: "capability_check" | "setup" | "dispatch" | "settlement";
      readonly effectState: "none" | "unknown";
    };

export interface SandboxExecutionGateway<TPayload = unknown> {
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult<TPayload>>;
  cancel(input: SandboxCancellationRequest): Promise<SandboxCancellationResult>;
}
