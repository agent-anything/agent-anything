import type {
  ExecPolicyRule,
  ManagedPermissionConstraints,
  NetworkPolicyRule,
  PersistentPolicyAmendmentPort,
} from "@agent-anything/governance";
import {
  snapshotExecPolicyRule,
  snapshotNetworkPolicyRule,
} from "@agent-anything/governance";
import {
  resolvePermissionProfile,
  type ApprovalPolicy,
  type PermissionProfileDefinition,
  type PermissionResolutionEnvironmentInput,
  type SessionAuthorityContext,
  type SessionAuthorityPort,
} from "@agent-anything/permission";
import type { InvocationInterruptionContext } from "@agent-anything/shared";
import {
  isReviewCapablePolicy,
  type ApprovalLimits,
  type ApprovalReviewerBinding,
  type AuthorityApplicationLimits,
  type ResolvedRunPermissionConfig,
} from "@agent-anything/agent-core/run";

export interface HostPermissionProfileSelection {
  readonly profileId: string;
  readonly profiles: readonly PermissionProfileDefinition[];
  readonly environment: PermissionResolutionEnvironmentInput;
}

export interface HostSessionAuthorityComposition {
  readonly context: SessionAuthorityContext;
  readonly port: SessionAuthorityPort;
  readonly maxInitialRecords: number;
}

export interface HostRunPermissionCompositionInput {
  readonly profile: HostPermissionProfileSelection;
  readonly approvalPolicy: ApprovalPolicy;
  readonly reviewer: ApprovalReviewerBinding | null;
  readonly rules: readonly ExecPolicyRule[];
  readonly networkRules: readonly NetworkPolicyRule[];
  readonly managedConstraints: ManagedPermissionConstraints;
  readonly sessionAuthority: HostSessionAuthorityComposition | null;
  readonly persistentPolicyAmendments: PersistentPolicyAmendmentPort | null;
  readonly approvalLimits: ApprovalLimits;
  readonly authorityApplicationLimits: AuthorityApplicationLimits;
  readonly interruption: InvocationInterruptionContext;
}

export async function resolveHostRunPermissionConfig(
  input: HostRunPermissionCompositionInput,
): Promise<ResolvedRunPermissionConfig> {
  assertComposition(input);
  const managedConstraints = deepFreeze(structuredClone(input.managedConstraints));
  const permissionProfile = resolvePermissionProfile({
    profileId: input.profile.profileId,
    profiles: input.profile.profiles,
    environment: input.profile.environment,
    managedConstraints,
  });

  const sessionAuthority = input.sessionAuthority === null
    ? null
    : await loadSessionAuthority(input.sessionAuthority, input.interruption);

  return Object.freeze({
    permissionProfile,
    approvalPolicy: snapshotApprovalPolicy(input.approvalPolicy),
    reviewer: snapshotReviewer(input.reviewer),
    rules: Object.freeze(input.rules.map(snapshotExecPolicyRule)),
    networkRules: Object.freeze(input.networkRules.map(snapshotNetworkPolicyRule)),
    managedConstraints,
    sessionAuthority,
    persistentPolicyAmendments: input.persistentPolicyAmendments,
    approvalLimits: Object.freeze({ ...input.approvalLimits }),
    authorityApplicationLimits: Object.freeze({
      ...input.authorityApplicationLimits,
    }),
  });
}

async function loadSessionAuthority(
  input: HostSessionAuthorityComposition,
  interruption: InvocationInterruptionContext,
) {
  if (!Number.isInteger(input.maxInitialRecords) || input.maxInitialRecords < 0) {
    throw new TypeError("Host Session authority maxInitialRecords must be a non-negative integer.");
  }
  if (interruption.signal.aborted) {
    throw new TypeError("Host permission composition was interrupted before Session authority loading.");
  }

  const records = await input.port.listApplicable({
    context: input.context,
    category: null,
    applicabilityKeys: [],
  }, interruption);

  if (interruption.signal.aborted) {
    throw new TypeError("Host permission composition was interrupted during Session authority loading.");
  }
  if (!Array.isArray(records)) {
    throw new TypeError("Host Session authority port returned an invalid record collection.");
  }
  if (records.length > input.maxInitialRecords) {
    throw new TypeError(
      `Host Session authority returned ${records.length} records; the configured limit is ${input.maxInitialRecords}.`,
    );
  }

  return Object.freeze({
    context: Object.freeze({ ...input.context }),
    initialRecords: Object.freeze(records.map((record) =>
      deepFreeze(structuredClone(record))
    )),
    port: input.port,
  });
}

function assertComposition(input: HostRunPermissionCompositionInput): void {
  if (!input || typeof input !== "object") {
    throw new TypeError("Host permission composition input is required.");
  }
  const reviewCapable = isReviewCapablePolicy(input.approvalPolicy);
  if (reviewCapable !== (input.reviewer !== null)) {
    throw new TypeError(
      reviewCapable
        ? "Host approval policy requires an explicit reviewer binding."
        : "Host non-reviewing approval policy must not include a reviewer binding.",
    );
  }
  if (!input.interruption || typeof input.interruption !== "object") {
    throw new TypeError("Host permission composition requires an interruption context.");
  }
}

function snapshotApprovalPolicy(
  policy: ApprovalPolicy,
): ApprovalPolicy {
  return typeof policy === "string"
    ? policy
    : deepFreeze(structuredClone(policy));
}

function snapshotReviewer(
  reviewer: ApprovalReviewerBinding | null,
): ApprovalReviewerBinding | null {
  if (reviewer === null) return null;
  return Object.freeze({
    ...reviewer,
    descriptor: Object.freeze({
      ...reviewer.descriptor,
      metadata: deepFreeze(structuredClone(reviewer.descriptor.metadata)),
    }),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
