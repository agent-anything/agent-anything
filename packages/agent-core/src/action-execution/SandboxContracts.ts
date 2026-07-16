import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import type { ToolResult } from "@agent-anything/tools";
import type { RuntimeError } from "../runner/RuntimeError.js";
import type { ActionDispatchPlan } from "./ActionRevalidation.js";
import type { ActionExecutorDescriptor } from "./ActionRegistration.js";
import type { CanonicalEffectivePermissions } from "./CanonicalEffectivePermissions.js";
import type { CanonicalEnvironmentIdentity } from "./CanonicalIdentity.js";
import type { ActionEffectSet, CapabilityEffect } from "./CapabilityEffect.js";
import type { PreparedActionInvocation } from "./PreparedActionInvocation.js";

export type SandboxEnforcement = "managed" | "external" | "disabled";
export type SandboxProviderKind = Exclude<SandboxEnforcement, "disabled">;
export type CapabilityEffectKind = CapabilityEffect["kind"];

export interface ActionExecutionLimits {
  readonly maxResultBytes: number;
}

export interface SandboxAttempt {
  readonly id: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly ordinal: 1 | 2;
  readonly enforcement: SandboxEnforcement;
  readonly policyId: string;
  readonly authoritySnapshotId: string;
  readonly dispatchPlanFingerprint: string;
  readonly startedAt: ISODateTimeString;
}

export interface CanonicalEnvironmentPolicy {
  readonly kind: "bound_configuration";
  readonly environment: CanonicalEnvironmentIdentity;
}

export interface SandboxPolicyEnvelope {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly actionFingerprint: string;
  readonly authoritySnapshotId: string;
  readonly enforcement: SandboxEnforcement;
  readonly defaultDisposition: "deny";
  readonly authorizedEffects: ActionEffectSet;
  readonly fileSystemPermissions: CanonicalEffectivePermissions["fileSystem"];
  readonly processPermissions: CanonicalEffectivePermissions["process"];
  readonly networkPermissions: CanonicalEffectivePermissions["network"];
  readonly remoteToolPermissions: CanonicalEffectivePermissions["remoteTool"];
  readonly environmentPolicy: CanonicalEnvironmentPolicy;
  readonly resourceLimits: ActionExecutionLimits;
  readonly allowedSecretReferences: readonly string[];
}

export interface DispatchSandboxActionInput {
  readonly plan: ActionDispatchPlan;
  readonly preparedInvocation: PreparedActionInvocation;
  readonly deadlineAt: ISODateTimeString;
  readonly interruption: InvocationInterruptionContext;
}

export interface SandboxExecutionRequest {
  readonly attempt: SandboxAttempt;
  readonly policy: SandboxPolicyEnvelope;
  readonly executor: ActionExecutorDescriptor;
  readonly invocation: PreparedActionInvocation;
  readonly deadlineAt: ISODateTimeString;
}

export interface SandboxCancellationRequest {
  readonly attemptId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly interruption: InvocationInterruptionRef;
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
  readonly supportedEffectKinds: readonly CapabilityEffectKind[];
}

export interface SandboxEnforcementEvidence {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly policyId: string;
  readonly enforcement: SandboxProviderKind;
  readonly enforcedEffectKinds: readonly CapabilityEffectKind[];
  readonly settledAt: ISODateTimeString;
}

export interface SandboxDenial {
  readonly attemptId: string;
  readonly runId: string;
  readonly actionId: string;
  readonly actionFingerprint: string;
  readonly ordinal: 1 | 2;
  readonly code: string;
  readonly deniedEffect: CapabilityEffect;
  readonly effectState: "none" | "unknown";
  readonly message: string;
}

export type SandboxProviderResult =
  | {
      readonly status: "executed";
      readonly toolResult: ToolResult;
      readonly enforcementEvidence: SandboxEnforcementEvidence;
    }
  | { readonly status: "denied"; readonly denial: SandboxDenial }
  | {
      readonly status: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    }
  | {
      readonly status: "enforcement_failed";
      readonly stage: "capability_check" | "setup" | "dispatch" | "settlement";
      readonly code: string;
      readonly effectState: "none" | "unknown";
    };

export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  readonly descriptor: SandboxProviderDescriptor;
  execute(input: SandboxExecutionRequest): Promise<SandboxProviderResult>;
  cancel(input: SandboxCancellationRequest): Promise<SandboxCancellationResult>;
}

export type ActionExecutionResult =
  | {
      readonly status: "executed";
      readonly attempt: SandboxAttempt;
      readonly toolResult: ToolResult;
      readonly isolation: "enforced" | "unisolated";
      readonly enforcementEvidence: SandboxEnforcementEvidence | null;
    }
  | {
      readonly status: "sandbox_denied";
      readonly attempt: SandboxAttempt;
      readonly denial: SandboxDenial;
    }
  | {
      readonly status: "sandbox_unavailable";
      readonly attempt: SandboxAttempt;
      readonly code: string;
      readonly stage: "capability_check" | "setup" | "dispatch" | "settlement";
      readonly effectState: "none" | "unknown";
    }
  | {
      readonly status: "interrupted";
      readonly attempt: SandboxAttempt | null;
      readonly interruption: InvocationInterruptionRef;
    }
  | { readonly status: "failed"; readonly attempt: SandboxAttempt | null; readonly error: RuntimeError };

export interface SandboxExecutionGateway {
  dispatch(input: DispatchSandboxActionInput): Promise<ActionExecutionResult>;
}
