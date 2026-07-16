import type {
  ExecPolicyAmendment,
  NetworkPolicyAmendment,
} from "@agent-anything/governance";
import type {
  ActionApprovalCause,
  ApprovalCategory,
  ApprovalDecisionOption,
  ApprovalPayloadByCategory,
  ApprovalRequirement,
  ApprovalTrustedProposal,
  CanonicalAdditionalPermissions,
} from "@agent-anything/permission";
import type { ActionAssessmentAuthoritySnapshot } from "./ActionAssessment.js";
import { contractError } from "./ActionContractValidation.js";
import type { DerivedActionAuthority } from "./ActionAuthorityAssessment.js";
import type { CanonicalFileOperation } from "./CanonicalActionOperation.js";
import type { PreparedExternalAction } from "./PreparedExternalAction.js";

export function requiredApprovalCategory(
  prepared: PreparedExternalAction,
): ApprovalCategory {
  switch (prepared.subject.operation.kind) {
    case "process": return "commandExecution";
    case "network": return "networkAccess";
    case "remote_tool": return "mcpToolCall";
    case "skill": return "skill";
    case "file_system":
      return prepared.subject.operation.operations.some(isMutation)
        ? "fileChange"
        : "permissions";
  }
}

export function assertApprovalMapping(input: {
  readonly prepared: PreparedExternalAction;
  readonly requiredForReview: boolean;
  readonly missingPermissions: CanonicalAdditionalPermissions | null;
}): void {
  const { prepared } = input;
  if (!input.requiredForReview) return;
  const expected = requiredApprovalCategory(prepared);
  if (prepared.approvalCategory !== expected || prepared.approvalPayload === null) {
    throw contractError(
      "canonical_contract_invalid",
      `The prepared Action requires the '${expected}' approval mapping.`,
      "prepared.approvalCategory",
    );
  }
  const payload = prepared.approvalPayload;
  const operation = prepared.subject.operation;
  if (expected === "commandExecution") {
    if (operation.kind !== "process") mismatch();
    const typed = payload as ApprovalPayloadByCategory["commandExecution"];
    if (!sameStrings(typed.command, commandTokens(prepared)) ||
      typed.cwd !== operation.cwd.canonicalPath ||
      typed.environmentId !== prepared.subject.environment.environmentId ||
      !samePermissions(typed.additionalPermissions, prepared.subject.requestedPermissions)) mismatch();
  } else if (expected === "fileChange") {
    if (operation.kind !== "file_system") mismatch();
    const typed = payload as ApprovalPayloadByCategory["fileChange"];
    const mutations = operation.operations.filter(isMutation);
    if (typed.changes.length !== mutations.length ||
      mutations.some((entry, index) => !fileChangeMatches(typed.changes[index]!, entry)) ||
      !samePermissions(typed.additionalPermissions, prepared.subject.requestedPermissions)) mismatch();
  } else if (expected === "permissions") {
    const typed = payload as ApprovalPayloadByCategory["permissions"];
    const required = prepared.subject.requestedPermissions ?? input.missingPermissions;
    if (required === null || typed.environmentId !== prepared.subject.environment.environmentId ||
      !samePermissions(typed.permissions, required)) mismatch();
  } else if (expected === "networkAccess") {
    if (operation.kind !== "network") mismatch();
    const typed = payload as ApprovalPayloadByCategory["networkAccess"];
    if (typed.host !== operation.endpoint.host || typed.port !== operation.endpoint.port ||
      typed.protocol !== operation.endpoint.applicationProtocol) mismatch();
    if (prepared.subject.requestedPermissions !== null && !samePermissions(
      prepared.subject.requestedPermissions,
      { network: { enabled: true, domains: [operation.endpoint.host] } },
    )) mismatch();
  } else if (expected === "mcpToolCall") {
    if (operation.kind !== "remote_tool") mismatch();
    const typed = payload as ApprovalPayloadByCategory["mcpToolCall"];
    if (typed.serverId !== operation.target.server.serverId ||
      typed.toolName !== operation.target.toolName) mismatch();
  } else if (expected === "skill") {
    if (operation.kind !== "skill") mismatch();
    const typed = payload as ApprovalPayloadByCategory["skill"];
    if (typed.skillId !== operation.skillId || typed.action !== operation.action ||
      !samePermissions(typed.requiredPermissions, prepared.subject.requestedPermissions)) mismatch();
  } else {
    mismatch();
  }
}

export function createActionApprovalRequirement(input: {
  readonly prepared: PreparedExternalAction;
  readonly authority: ActionAssessmentAuthoritySnapshot;
  readonly derivedAuthority: DerivedActionAuthority;
  readonly causes: readonly ActionApprovalCause[];
}): ApprovalRequirement {
  const category = input.prepared.approvalCategory;
  const payload = input.prepared.approvalPayload;
  if (category === null || payload === null) {
    throw new TypeError("Approval requirement needs a trusted category mapping.");
  }
  const prefix = input.prepared.actionFingerprint;
  const grantablePermissions = permissionsExpressedByPayload(category, payload);
  const options: ApprovalDecisionOption[] = [];
  const proposals: ApprovalTrustedProposal[] = [];

  if (category !== "permissions") {
    options.push(option(`${prefix}:accept`, "accept", "action", "Approve once", null));
  }
  if (input.authority.sessionAuthorityContext !== null &&
    input.prepared.applicabilityKeys.length > 0) {
    const ref = `${prefix}:session-authority`;
    options.push(option(
      `${prefix}:accept-session`,
      category === "permissions" ? "grantPermissions" : "acceptForSession",
      "session",
      category === "permissions" ? "Grant for this session" : "Approve for this session",
      ref,
    ));
    proposals.push({
      kind: "session_authority",
      ref,
      proposal: {
        proposalRef: ref,
        context: input.authority.sessionAuthorityContext,
        category,
        applicabilityKeys: input.prepared.applicabilityKeys as [typeof input.prepared.applicabilityKeys[number], ...typeof input.prepared.applicabilityKeys[number][]],
        defaultGrantedPermissions: grantablePermissions,
      },
    });
  }
  if (grantablePermissions !== null) {
    options.push(option(`${prefix}:grant-run`, "grantPermissions", "run", "Grant for this run", null));
  }
  addPersistentProposal(input, options, proposals);
  options.push(option(`${prefix}:decline`, "decline", null, "Decline", null));
  options.push(option(`${prefix}:cancel`, "cancel", null, "Cancel run", null));

  return deepFreeze({
    category,
    subject: {
      runId: input.prepared.action.runId,
      actionId: input.prepared.action.id,
      actionFingerprint: input.prepared.actionFingerprint,
      environmentId: input.prepared.subject.environment.environmentId,
      applicabilityKeys: input.prepared.applicabilityKeys,
    },
    reason: reason(input.causes),
    payload,
    decisionOptions: options as [ApprovalDecisionOption, ...ApprovalDecisionOption[]],
    trustedProposals: proposals,
    deadlineAt: input.authority.approvalDeadlineAt,
    metadata: { causes: [...input.causes] },
  }) as ApprovalRequirement;
}

function permissionsExpressedByPayload(
  category: ApprovalCategory,
  payload: ApprovalPayloadByCategory[ApprovalCategory],
): CanonicalAdditionalPermissions | null {
  switch (category) {
    case "commandExecution":
      return (payload as ApprovalPayloadByCategory["commandExecution"]).additionalPermissions;
    case "fileChange":
      return (payload as ApprovalPayloadByCategory["fileChange"]).additionalPermissions;
    case "permissions":
      return (payload as ApprovalPayloadByCategory["permissions"]).permissions;
    case "skill":
      return (payload as ApprovalPayloadByCategory["skill"]).requiredPermissions;
    case "networkAccess": {
      const network = payload as ApprovalPayloadByCategory["networkAccess"];
      return { network: { enabled: true, domains: [network.host] } };
    }
    case "mcpToolCall":
      return null;
  }
}

function addPersistentProposal(
  input: Parameters<typeof createActionApprovalRequirement>[0],
  options: ApprovalDecisionOption[],
  proposals: ApprovalTrustedProposal[],
): void {
  const approvalPolicy = input.authority.approvalPolicy;
  if (approvalPolicy === "never" ||
    (typeof approvalPolicy === "object" && !approvalPolicy.granular.rules)) {
    return;
  }
  const operation = input.prepared.subject.operation;
  const prefix = input.prepared.actionFingerprint;
  if (operation.kind === "process") {
    const ref = `${prefix}:exec-policy`;
    const amendment: ExecPolicyAmendment = {
      amendmentId: `${prefix}:exec-amendment`,
      environmentId: input.prepared.subject.environment.environmentId,
      commandPattern: commandTokens(input.prepared) as [string, ...string[]],
      cwd: operation.cwd.canonicalPath,
      effect: "allow",
      sourceFingerprint: input.prepared.actionFingerprint,
    };
    options.push(option(`${prefix}:allow-command`, "acceptWithExecpolicyAmendment", "persistent", "Always allow this command", ref));
    proposals.push({ kind: "exec_policy_amendment", ref, amendment });
  }
  if (operation.kind === "network") {
    const ref = `${prefix}:network-policy`;
    const amendment: NetworkPolicyAmendment = {
      amendmentId: `${prefix}:network-amendment`,
      environmentId: input.prepared.subject.environment.environmentId,
      hostPattern: operation.endpoint.host,
      ports: [operation.endpoint.port],
      protocols: operation.endpoint.applicationProtocol === null ? [] : [operation.endpoint.applicationProtocol],
      effect: "allow",
      sourceFingerprint: input.prepared.actionFingerprint,
    };
    options.push(option(`${prefix}:allow-network`, "applyNetworkPolicyAmendment", "persistent", "Always allow this network target", ref));
    proposals.push({ kind: "network_policy_amendment", ref, amendment });
  }
}

function option(
  id: string,
  kind: ApprovalDecisionOption["kind"],
  scope: ApprovalDecisionOption["scope"],
  label: string,
  trustedProposalRef: string | null,
): ApprovalDecisionOption {
  return { id, kind, scope, label, description: null, trustedProposalRef, metadata: {} };
}

function reason(causes: readonly ActionApprovalCause[]): string {
  const labels: Record<ActionApprovalCause, string> = {
    governance_review: "Governance requires review",
    rule_prompt: "an applicable Rule requires confirmation",
    missing_authority: "the Action requires additional authority",
  };
  return `${causes.map((cause) => labels[cause]).join("; ")}.`;
}

function commandTokens(prepared: PreparedExternalAction): readonly string[] {
  if (prepared.subject.operation.kind !== "process") return [];
  return [
    prepared.subject.operation.executable.path.canonicalPath,
    ...prepared.subject.operation.arguments.map((argument) =>
      argument.kind === "literal" ? argument.value : `<secret:${argument.reference}>`),
  ];
}

function isMutation(entry: CanonicalFileOperation): boolean {
  return !["read", "list", "search"].includes(entry.operation);
}

function fileChangeMatches(
  change: ApprovalPayloadByCategory["fileChange"]["changes"][number],
  operation: CanonicalFileOperation,
): boolean {
  if (!isMutation(operation) || change.operation !== operation.operation) return false;
  if ("target" in operation) {
    return change.canonicalPath === operation.target.path.canonicalPath &&
      change.destinationCanonicalPath === null;
  }
  return change.canonicalPath === operation.source.path.canonicalPath &&
    change.destinationCanonicalPath === operation.destination.path.canonicalPath;
}

function samePermissions(
  left: CanonicalAdditionalPermissions | null,
  right: CanonicalAdditionalPermissions | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mismatch(): never {
  throw contractError(
    "canonical_contract_invalid",
    "Approval category payload contradicts the canonical Action operation.",
    "prepared.approvalPayload",
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
