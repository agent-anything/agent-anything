import type {
  ApprovalCategory,
} from "./ApprovalCategory.js";
import type {
  ApprovalDecisionOption,
  ApprovalRequestBase,
  ApprovalRequirement,
  ApprovalTrustedProposal,
} from "./ApprovalContracts.js";
import { ApprovalContractError } from "./ApprovalContractError.js";
import {
  cloneApprovalMetadata,
  cloneApprovalValue,
  deepFreezeApproval,
} from "./snapshot.js";

export interface CreateApprovalRequestInput<
  TCategory extends ApprovalCategory = ApprovalCategory,
> {
  readonly id: string;
  readonly requirement: ApprovalRequirement<TCategory>;
  readonly createdAt: string;
}

export function createApprovalRequest<TCategory extends ApprovalCategory>(
  input: CreateApprovalRequestInput<TCategory>,
): ApprovalRequestBase<TCategory> {
  validateIdentity(input.id, "request id");
  validateIdentity(input.requirement.subject.runId, "run id");
  validateIdentity(input.requirement.subject.actionId, "action id");
  validateIdentity(input.requirement.subject.actionFingerprint, "action fingerprint");
  validateIdentity(input.requirement.subject.environmentId, "environment id");
  validateTimestamp(input.createdAt, "createdAt");
  validateTimestamp(input.requirement.deadlineAt, "deadlineAt");
  if (input.requirement.reason.length === 0) {
    throw new ApprovalContractError(
      "approval_request_invalid_subject",
      "Approval reason must not be empty.",
    );
  }
  validateApplicabilityKeys(input.requirement);
  validateOptions(input.requirement.category, input.requirement.decisionOptions);
  validateProposals(
    input.requirement.category,
    input.requirement.decisionOptions,
    input.requirement.trustedProposals,
  );
  validatePayload(input.requirement);

  const decisionOptions = mapNonEmpty(
    input.requirement.decisionOptions,
    (option) => ({
      ...option,
      metadata: cloneApprovalMetadata(option.metadata),
    }),
  );

  return deepFreezeApproval({
    id: input.id,
    runId: input.requirement.subject.runId,
    actionId: input.requirement.subject.actionId,
    actionFingerprint: input.requirement.subject.actionFingerprint,
    category: input.requirement.category,
    subject: cloneApprovalValue(input.requirement.subject, "subject"),
    reason: input.requirement.reason,
    payload: cloneApprovalValue(input.requirement.payload, "payload"),
    decisionOptions,
    trustedProposals: cloneApprovalValue(
      input.requirement.trustedProposals,
      "trustedProposals",
    ),
    createdAt: input.createdAt,
    deadlineAt: input.requirement.deadlineAt,
    metadata: cloneApprovalMetadata(input.requirement.metadata),
  });
}

function validateOptions(
  category: ApprovalCategory,
  options: readonly ApprovalDecisionOption[],
): void {
  if (options.length === 0) {
    throw new ApprovalContractError(
      "approval_request_invalid_option",
      "Approval request must offer at least one decision option.",
    );
  }
  const ids = new Set<string>();
  for (const option of options) {
    validateIdentity(option.id, "option id");
    if (ids.has(option.id)) {
      throw new ApprovalContractError(
        "approval_request_duplicate_option",
        `Approval option '${option.id}' is duplicated.`,
      );
    }
    ids.add(option.id);
    if (option.label.length === 0 || !isCompatibleOption(category, option)) {
      throw new ApprovalContractError(
        "approval_request_invalid_option",
        `Approval option '${option.id}' is incompatible with category '${category}'.`,
      );
    }
  }
}

function isCompatibleOption(
  category: ApprovalCategory,
  option: ApprovalDecisionOption,
): boolean {
  switch (option.kind) {
    case "accept":
      return category !== "permissions" && option.scope === "action" && option.trustedProposalRef === null;
    case "acceptForSession":
      return category !== "permissions" && option.scope === "session" && option.trustedProposalRef !== null;
    case "grantPermissions":
      return (
        (category === "permissions" ||
          category === "commandExecution" ||
          category === "fileChange" ||
          category === "skill" ||
          category === "networkAccess") &&
        (option.scope === "run" || option.scope === "session") &&
        (option.scope === "run"
          ? option.trustedProposalRef === null
          : option.trustedProposalRef !== null)
      );
    case "acceptWithExecpolicyAmendment":
      return category === "commandExecution" && option.scope === "persistent" && option.trustedProposalRef !== null;
    case "applyNetworkPolicyAmendment":
      return (
        (category === "commandExecution" || category === "networkAccess") &&
        option.scope === "persistent" &&
        option.trustedProposalRef !== null
      );
    case "decline":
    case "cancel":
      return option.scope === null && option.trustedProposalRef === null;
  }
}

function validateProposals(
  category: ApprovalCategory,
  options: readonly ApprovalDecisionOption[],
  proposals: readonly ApprovalTrustedProposal[],
): void {
  const refs = new Map<string, ApprovalTrustedProposal>();
  for (const proposal of proposals) {
    validateIdentity(proposal.ref, "trusted proposal ref");
    if (refs.has(proposal.ref)) {
      throw new ApprovalContractError(
        "approval_request_duplicate_proposal",
        `Trusted proposal '${proposal.ref}' is duplicated.`,
      );
    }
    refs.set(proposal.ref, proposal);
    if (
      proposal.kind === "session_authority" &&
      (proposal.proposal.proposalRef !== proposal.ref ||
        proposal.proposal.category !== category ||
        proposal.proposal.applicabilityKeys.length === 0 ||
        proposal.proposal.applicabilityKeys.some((key) => key.category !== category))
    ) {
      throw new ApprovalContractError(
        "approval_request_invalid_proposal",
        `Session proposal '${proposal.ref}' is invalid for category '${category}'.`,
      );
    }
  }

  for (const option of options) {
    if (option.trustedProposalRef === null) continue;
    const proposal = refs.get(option.trustedProposalRef);
    if (!proposal || !proposalMatchesOption(proposal, option)) {
      throw new ApprovalContractError(
        "approval_request_invalid_proposal",
        `Approval option '${option.id}' has no matching trusted proposal.`,
      );
    }
  }
}

function proposalMatchesOption(
  proposal: ApprovalTrustedProposal,
  option: ApprovalDecisionOption,
): boolean {
  if (option.kind === "acceptForSession" || (option.kind === "grantPermissions" && option.scope === "session")) {
    return proposal.kind === "session_authority";
  }
  if (option.kind === "acceptWithExecpolicyAmendment") {
    return proposal.kind === "exec_policy_amendment";
  }
  if (option.kind === "applyNetworkPolicyAmendment") {
    return proposal.kind === "network_policy_amendment";
  }
  return false;
}

function validateApplicabilityKeys(requirement: ApprovalRequirement): void {
  const values = new Set<string>();
  for (const key of requirement.subject.applicabilityKeys) {
    if (key.category !== requirement.category || key.value.length === 0 || values.has(key.value)) {
      throw new ApprovalContractError(
        "approval_request_invalid_subject",
        "Approval applicability keys must be unique and match the request category.",
      );
    }
    values.add(key.value);
  }
}

function validatePayload(requirement: ApprovalRequirement): void {
  const payload = requirement.payload as Record<string, unknown>;
  if (typeof payload !== "object" || payload === null) {
    throw new ApprovalContractError(
      "approval_request_invalid_payload",
      "Approval payload must be an object.",
    );
  }
  switch (requirement.category) {
    case "commandExecution":
      if (!Array.isArray(payload.command) || payload.command.length === 0) invalidPayload();
      break;
    case "fileChange":
      if (!Array.isArray(payload.changes) || payload.changes.length === 0) invalidPayload();
      break;
    case "permissions":
      if (!payload.permissions) invalidPayload();
      break;
    case "mcpToolCall":
      if (typeof payload.serverId !== "string" || typeof payload.toolName !== "string") invalidPayload();
      break;
    case "skill":
      if (typeof payload.skillId !== "string" || typeof payload.action !== "string") invalidPayload();
      break;
    case "networkAccess":
      if (typeof payload.host !== "string" || payload.host.length === 0) invalidPayload();
      break;
  }
}

function invalidPayload(): never {
  throw new ApprovalContractError(
    "approval_request_invalid_payload",
    "Approval category payload is malformed.",
  );
}

function validateIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new ApprovalContractError(
      "approval_request_invalid_identity",
      `Approval ${label} is invalid.`,
    );
  }
}

function validateTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) {
    throw new ApprovalContractError(
      "approval_request_invalid_identity",
      `Approval ${label} is invalid.`,
    );
  }
}

function mapNonEmpty<TInput, TOutput>(
  values: readonly [TInput, ...TInput[]],
  mapper: (value: TInput) => TOutput,
): readonly [TOutput, ...TOutput[]] {
  const [first, ...rest] = values;
  return [mapper(first), ...rest.map(mapper)];
}
