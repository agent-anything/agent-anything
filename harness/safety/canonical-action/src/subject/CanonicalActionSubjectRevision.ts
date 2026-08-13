import type { RunActionRef } from "@agent-anything/agent-core/run-action";
import type {
  OperationBindingRevisionRef,
  OperationCorrelation,
  OperationInvocationRef,
  OperationRevisionRef,
} from "@agent-anything/operation-catalog/identity";
import type {
  CanonicalActorIdentity,
  CanonicalEnvironmentIdentity,
  CanonicalWorkspaceIdentity,
} from "./CanonicalIdentity.js";
import type { CapabilityEffect } from "./CapabilityEffect.js";
import { createCanonicalSha256Digest } from "./CanonicalEncoding.js";

export interface CanonicalActionRef {
  readonly id: string;
}

export interface ActionSubjectRevisionRef {
  readonly action: CanonicalActionRef;
  readonly revision: number;
}

export interface ActionAttemptRef {
  readonly action: CanonicalActionRef;
  readonly id: string;
  readonly ordinal: number;
}

export interface ActionSettlementRef {
  readonly action: CanonicalActionRef;
  readonly id: string;
}

export type CanonicalTarget =
  | { readonly kind: "filesystem"; readonly identityKey: string }
  | { readonly kind: "process"; readonly identityKey: string }
  | { readonly kind: "network"; readonly identityKey: string }
  | { readonly kind: "remote_invocation"; readonly identityKey: string }
  | { readonly kind: "computer_environment"; readonly identityKey: string };

export interface CanonicalActionSubjectRevision {
  readonly ref: ActionSubjectRevisionRef;
  readonly previousRevision: ActionSubjectRevisionRef | null;
  readonly parentRunAction: RunActionRef | null;
  readonly operation: OperationRevisionRef;
  readonly operationInvocation: OperationInvocationRef;
  readonly binding: OperationBindingRevisionRef;
  readonly correlation: OperationCorrelation;
  readonly workspace: CanonicalWorkspaceIdentity | null;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentity;
  readonly targets: readonly CanonicalTarget[];
  readonly effects: readonly [CapabilityEffect, ...CapabilityEffect[]];
  readonly currentStateAssertions: readonly string[];
  readonly preparedInvocationDigest: string;
  readonly executorRegistrationFingerprint: string;
  readonly sandboxRequirementRevision: string;
  readonly requestedAuthorityDigest: string;
  readonly safeReviewProjectionDigest: string;
  readonly replayBasis: "none" | "never_dispatched" | "confirmed_no_effect" | "revalidated_observation" | "external_idempotency";
  readonly deadlineAt: string | null;
  readonly createdAt: string;
  readonly provenance: string;
}

export const CANONICAL_ACTION_SUBJECT_FINGERPRINT_DOMAIN =
  "agent-anything.canonical-action-subject.v1";

export function createCanonicalActionSubjectFingerprint(
  subject: CanonicalActionSubjectRevision,
): Promise<string> {
  return createCanonicalSha256Digest(CANONICAL_ACTION_SUBJECT_FINGERPRINT_DOMAIN, subject);
}
