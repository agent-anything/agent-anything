import type { ManagedPermissionConstraints } from "@agent-anything/governance/managed-permission";
import { normalizePolicyAmendment } from "@agent-anything/governance/amendment";
import type { PermissionResolutionEnvironmentInput } from "../profile/PermissionProfile.js";
import type {
  RunPermissionGrant,
  SessionAuthorityProposal,
  SessionAuthorityRecord,
  ValidatedActionAuthority,
} from "../authority/AuthorityContracts.js";
import type {
  ApprovalDecisionOption,
  ApprovalDecisionSubmission,
  ApprovalRequest,
  ApprovalTrustedProposal,
  ValidatedApprovalDecision,
} from "./ApprovalContracts.js";
import type {
  AdditionalPermissions,
  CanonicalAdditionalPermissions,
  GrantedPermissions,
  PermissionDeltaValidationCode,
} from "./PermissionDelta.js";
import { validateGrantedPermissions } from "./PermissionDelta.js";
import { deepFreezeApproval } from "./snapshot.js";

export type ApprovalDecisionValidationCode =
  | "approval_submission_invalid"
  | "approval_correlation_mismatch"
  | "approval_version_mismatch"
  | "approval_option_not_offered"
  | "approval_option_unsupported"
  | "approval_trusted_proposal_missing"
  | "approval_trusted_proposal_mismatch"
  | "approval_permissions_not_requested"
  | PermissionDeltaValidationCode;

export type ValidateApprovalDecisionResult =
  | { readonly status: "valid"; readonly decision: ValidatedApprovalDecision }
  | {
      readonly status: "invalid";
      readonly code: ApprovalDecisionValidationCode;
      readonly message: string;
    };

export interface ValidateApprovalDecisionInput {
  readonly request: ApprovalRequest;
  readonly pendingVersion: number;
  readonly submission: ApprovalDecisionSubmission;
  readonly cwd: string;
  readonly environment: PermissionResolutionEnvironmentInput;
  readonly managedConstraints: ManagedPermissionConstraints;
  readonly identities: {
    readonly actionAuthorityId: string;
    readonly runPermissionGrantId: string;
    readonly sessionAuthorityRecordId: string;
  };
  readonly validatedAt: string;
}

export function validateApprovalDecision(
  input: ValidateApprovalDecisionInput,
): ValidateApprovalDecisionResult {
  const correlationFailure = validateCorrelation(input);
  if (correlationFailure) return correlationFailure;

  const option = input.request.decisionOptions.find(
    (candidate) => candidate.id === input.submission.optionId,
  );
  if (!option) {
    return invalid(
      "approval_option_not_offered",
      `Approval option '${input.submission.optionId}' was not offered.`,
    );
  }

  switch (option.kind) {
    case "accept":
      return validateAccept(input, option);
    case "acceptForSession":
      return validateAcceptForSession(input, option);
    case "grantPermissions":
      return validatePermissionGrant(input, option);
    case "acceptWithExecpolicyAmendment":
      return validateExecPolicyAmendment(input, option);
    case "applyNetworkPolicyAmendment":
      return validateNetworkPolicyAmendment(input, option);
    case "decline":
      if (input.submission.grantedPermissions !== null) return unexpectedPermissions();
      return valid({ kind: "decline", reason: input.submission.reason });
    case "cancel":
      if (input.submission.grantedPermissions !== null) return unexpectedPermissions();
      return valid({ kind: "cancel" });
  }
}

function validateAccept(
  input: ValidateApprovalDecisionInput,
  option: ApprovalDecisionOption,
): ValidateApprovalDecisionResult {
  if (
    option.scope !== "action" ||
    option.trustedProposalRef !== null ||
    input.request.category === "permissions" ||
    input.submission.grantedPermissions !== null
  ) {
    return unsupported(option);
  }
  const requested = requestedPermissions(input.request);
  const granted = requested
    ? validateGrant(input, requested, asAdditionalPermissions(requested))
    : null;
  if (granted && "status" in granted) return granted;

  const authority: ValidatedActionAuthority = {
    id: input.identities.actionAuthorityId,
    runId: input.request.runId,
    actionId: input.request.actionId,
    actionFingerprint: input.request.actionFingerprint,
    sourceRequestId: input.request.id,
    grantedPermissions: granted,
    validatedAt: input.validatedAt,
  };
  return valid({
    kind: "accept",
    optionId: option.id,
    actionAuthority: deepFreezeApproval(authority),
  });
}

function validateAcceptForSession(
  input: ValidateApprovalDecisionInput,
  option: ApprovalDecisionOption,
): ValidateApprovalDecisionResult {
  if (
    option.scope !== "session" ||
    option.trustedProposalRef === null ||
    input.request.category === "permissions" ||
    input.submission.grantedPermissions !== null
  ) {
    return unsupported(option);
  }
  const proposal = findSessionProposal(input.request, option.trustedProposalRef);
  if (isInvalid(proposal)) return proposal;

  const requested = requestedPermissions(input.request);
  let granted: GrantedPermissions | null = null;
  if (proposal.defaultGrantedPermissions) {
    if (!requested) {
      return invalid(
        "approval_trusted_proposal_mismatch",
        "Session proposal grants permissions that the request did not contain.",
      );
    }
    const result = validateGrant(
      input,
      requested,
      asAdditionalPermissions(proposal.defaultGrantedPermissions),
    );
    if (isInvalid(result)) return result;
    granted = result;
  }

  return valid({
    kind: "acceptForSession",
    optionId: option.id,
    sessionAuthority: createSessionRecord(input, proposal, granted),
  });
}

function validatePermissionGrant(
  input: ValidateApprovalDecisionInput,
  option: ApprovalDecisionOption,
): ValidateApprovalDecisionResult {
  if (
    (option.scope !== "run" && option.scope !== "session") ||
    input.submission.grantedPermissions === null
  ) {
    return unsupported(option);
  }
  const requested = requestedPermissions(input.request);
  if (!requested) {
    return invalid(
      "approval_permissions_not_requested",
      "The approval request contains no permission upper bound.",
    );
  }
  const grant = validateGrant(input, requested, input.submission.grantedPermissions);
  if (isInvalid(grant)) return grant;

  if (option.scope === "run") {
    if (option.trustedProposalRef !== null) return unsupported(option);
    const record: RunPermissionGrant = deepFreezeApproval({
      id: input.identities.runPermissionGrantId,
      runId: input.request.runId,
      sourceRequestId: input.request.id,
      sourceActionFingerprint: input.request.actionFingerprint,
      permissions: grant,
      createdAt: input.validatedAt,
    });
    return valid({
      kind: "grantPermissions",
      optionId: option.id,
      authority: { scope: "run", grant: record },
    });
  }

  if (option.trustedProposalRef === null) return unsupported(option);
  const proposal = findSessionProposal(input.request, option.trustedProposalRef);
  if (isInvalid(proposal)) return proposal;
  return valid({
    kind: "grantPermissions",
    optionId: option.id,
    authority: {
      scope: "session",
      record: createSessionRecord(input, proposal, grant),
    },
  });
}

function validateExecPolicyAmendment(
  input: ValidateApprovalDecisionInput,
  option: ApprovalDecisionOption,
): ValidateApprovalDecisionResult {
  if (
    input.request.category !== "commandExecution" ||
    option.scope !== "persistent" ||
    option.trustedProposalRef === null ||
    input.submission.grantedPermissions !== null
  ) {
    return unsupported(option);
  }
  const proposal = findProposal(
    input.request,
    option.trustedProposalRef,
    "exec_policy_amendment",
  );
  if (isInvalid(proposal)) return proposal;
  const normalized = normalizePolicyAmendment({
    kind: "exec_policy",
    amendment: proposal.amendment,
  });
  if (
    normalized.status === "invalid" ||
    normalized.amendment.kind !== "exec_policy" ||
    normalized.amendment.amendment.sourceFingerprint !==
      input.request.actionFingerprint ||
    normalized.amendment.amendment.environmentId !==
      input.request.subject.environmentId
  ) {
    return invalid(
      "approval_trusted_proposal_mismatch",
      "Exec-policy proposal does not match the approval subject.",
    );
  }
  return valid({
    kind: "acceptWithExecpolicyAmendment",
    optionId: option.id,
    trustedProposalRef: proposal.ref,
    amendment: normalized.amendment.amendment,
  });
}

function validateNetworkPolicyAmendment(
  input: ValidateApprovalDecisionInput,
  option: ApprovalDecisionOption,
): ValidateApprovalDecisionResult {
  if (
    (input.request.category !== "commandExecution" &&
      input.request.category !== "networkAccess") ||
    option.scope !== "persistent" ||
    option.trustedProposalRef === null ||
    input.submission.grantedPermissions !== null
  ) {
    return unsupported(option);
  }
  const proposal = findProposal(
    input.request,
    option.trustedProposalRef,
    "network_policy_amendment",
  );
  if (isInvalid(proposal)) return proposal;
  const normalized = normalizePolicyAmendment({
    kind: "network_policy",
    amendment: proposal.amendment,
  });
  if (
    normalized.status === "invalid" ||
    normalized.amendment.kind !== "network_policy" ||
    normalized.amendment.amendment.sourceFingerprint !==
      input.request.actionFingerprint ||
    normalized.amendment.amendment.environmentId !==
      input.request.subject.environmentId
  ) {
    return invalid(
      "approval_trusted_proposal_mismatch",
      "Network-policy proposal does not match the approval subject.",
    );
  }
  return valid({
    kind: "applyNetworkPolicyAmendment",
    optionId: option.id,
    trustedProposalRef: proposal.ref,
    amendment: normalized.amendment.amendment,
  });
}

function validateCorrelation(
  input: ValidateApprovalDecisionInput,
): Extract<ValidateApprovalDecisionResult, { status: "invalid" }> | null {
  if (
    input.pendingVersion < 1 ||
    !nonEmpty(input.submission.submissionId) ||
    !nonEmpty(input.submission.optionId) ||
    !nonEmpty(input.identities.actionAuthorityId) ||
    !nonEmpty(input.identities.runPermissionGrantId) ||
    !nonEmpty(input.identities.sessionAuthorityRecordId) ||
    !nonEmpty(input.validatedAt)
  ) {
    return invalid("approval_submission_invalid", "Approval submission is malformed.");
  }
  if (
    input.submission.runId !== input.request.runId ||
    input.submission.requestId !== input.request.id
  ) {
    return invalid(
      "approval_correlation_mismatch",
      "Approval submission does not match the active request.",
    );
  }
  if (input.submission.pendingVersion !== input.pendingVersion) {
    return invalid(
      "approval_version_mismatch",
      "Approval submission pending version is stale.",
    );
  }
  return null;
}

function requestedPermissions(
  request: ApprovalRequest,
): CanonicalAdditionalPermissions | null {
  switch (request.category) {
    case "commandExecution":
    case "fileChange":
      return request.payload.additionalPermissions;
    case "permissions":
      return request.payload.permissions;
    case "skill":
      return request.payload.requiredPermissions;
    case "networkAccess":
      return {
        network: {
          enabled: true,
          domains: [request.payload.host],
        },
      };
    case "mcpToolCall":
      return null;
  }
}

function validateGrant(
  input: ValidateApprovalDecisionInput,
  requested: CanonicalAdditionalPermissions,
  granted: AdditionalPermissions,
): GrantedPermissions | Extract<ValidateApprovalDecisionResult, { status: "invalid" }> {
  const result = validateGrantedPermissions({
    requested,
    granted,
    cwd: input.cwd,
    environment: input.environment,
    managedConstraints: input.managedConstraints,
  });
  return result.status === "valid"
    ? result.permissions
    : invalid(result.code, result.message);
}

function findSessionProposal(
  request: ApprovalRequest,
  ref: string,
): SessionAuthorityProposal | Extract<ValidateApprovalDecisionResult, { status: "invalid" }> {
  const found = findProposal(request, ref, "session_authority");
  if (isInvalid(found)) return found;
  if (
    found.proposal.proposalRef !== ref ||
    found.proposal.category !== request.category ||
    found.proposal.context.environmentId !== request.subject.environmentId ||
    found.proposal.applicabilityKeys.length === 0 ||
    found.proposal.applicabilityKeys.some((key) => key.category !== request.category)
  ) {
    return invalid(
      "approval_trusted_proposal_mismatch",
      "Session authority proposal does not match the approval subject.",
    );
  }
  return found.proposal;
}

function findProposal<TKind extends ApprovalTrustedProposal["kind"]>(
  request: ApprovalRequest,
  ref: string,
  kind: TKind,
): Extract<ApprovalTrustedProposal, { kind: TKind }> |
  Extract<ValidateApprovalDecisionResult, { status: "invalid" }> {
  const proposal = request.trustedProposals.find((candidate) => candidate.ref === ref);
  if (!proposal) {
    return invalid(
      "approval_trusted_proposal_missing",
      `Trusted proposal '${ref}' is missing.`,
    );
  }
  if (proposal.kind !== kind) {
    return invalid(
      "approval_trusted_proposal_mismatch",
      `Trusted proposal '${ref}' has the wrong kind.`,
    );
  }
  return proposal as Extract<ApprovalTrustedProposal, { kind: TKind }>;
}

function createSessionRecord(
  input: ValidateApprovalDecisionInput,
  proposal: SessionAuthorityProposal,
  permissions: GrantedPermissions | null,
): SessionAuthorityRecord {
  return deepFreezeApproval({
    id: input.identities.sessionAuthorityRecordId,
    ...proposal.context,
    category: proposal.category,
    applicabilityKeys: proposal.applicabilityKeys.map((key) => ({ ...key })) as [
      (typeof proposal.applicabilityKeys)[number],
      ...(typeof proposal.applicabilityKeys)[number][],
    ],
    grantedPermissions: permissions,
    sourceRequestId: input.request.id,
    sourceActionFingerprint: input.request.actionFingerprint,
    createdAt: input.validatedAt,
  });
}

function asAdditionalPermissions(
  permissions: CanonicalAdditionalPermissions,
): AdditionalPermissions {
  return permissions;
}

function unexpectedPermissions(): ValidateApprovalDecisionResult {
  return invalid(
    "approval_option_unsupported",
    "This approval option does not accept a permission grant.",
  );
}

function unsupported(option: ApprovalDecisionOption): ValidateApprovalDecisionResult {
  return invalid(
    "approval_option_unsupported",
    `Approval option '${option.id}' has invalid category, scope, proposal, or payload.`,
  );
}

function valid(decision: ValidatedApprovalDecision): ValidateApprovalDecisionResult {
  return Object.freeze({ status: "valid", decision: deepFreezeApproval(decision) });
}

function invalid(
  code: ApprovalDecisionValidationCode,
  message: string,
): Extract<ValidateApprovalDecisionResult, { status: "invalid" }> {
  return Object.freeze({ status: "invalid", code, message });
}

function isInvalid(
  value: unknown,
): value is Extract<ValidateApprovalDecisionResult, { status: "invalid" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "invalid"
  );
}

function nonEmpty(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}
