import {
  evaluateExecPolicyRules,
  evaluateNetworkPolicyRules,
  type ActionPolicyCheckInput,
  type ActionPolicyEffectKind,
  type ActionRuleOutcome,
} from "@agent-anything/governance";
import type { ActionAssessmentAuthoritySnapshot } from "./ActionAssessment.js";
import {
  canonicalEndpointKey,
  canonicalPathTargetKey,
  canonicalRemoteToolTargetKey,
} from "./CanonicalIdentity.js";
import type { PreparedExternalAction } from "./PreparedExternalAction.js";

export function createActionPolicyInput(
  prepared: PreparedExternalAction,
): ActionPolicyCheckInput {
  return deepFreeze({
    kind: "prepared_action",
    checkId: `${prepared.action.id}:policy:${prepared.actionFingerprint}`,
    runId: prepared.action.runId,
    actionId: prepared.action.id,
    actionName: prepared.action.name,
    actionFingerprint: prepared.actionFingerprint,
    workspaceId: prepared.subject.workspace.workspaceId,
    workspaceTrustState: prepared.subject.workspace.trustState,
    identity: {
      kind: prepared.subject.identity.kind,
      id: prepared.subject.identity.identityId,
    },
    environmentId: prepared.subject.environment.environmentId,
    operation: {
      kind: prepared.subject.operation.kind,
      targetKeys: operationTargetKeys(prepared),
    },
    effects: prepared.subject.effectSet.kind === "effect_free"
      ? []
      : prepared.subject.effectSet.values.map((effect) => ({
          kind: effectKind(effect.kind, effect.operation),
          targetKeys: effectTargetKeys(effect),
        })),
    requestsAdditionalPermissions: prepared.subject.requestedPermissions !== null,
    metadata: {},
  });
}

export function evaluatePreparedActionRules(
  prepared: PreparedExternalAction,
  authority: ActionAssessmentAuthoritySnapshot,
): ActionRuleOutcome {
  const operation = prepared.subject.operation;
  const amendments = authority.appliedPolicyAmendments.map(({ amendment }) => amendment);
  if (operation.kind === "process") {
    return evaluateExecPolicyRules({
      command: [
        operation.executable.path.canonicalPath,
        ...operation.arguments.map((argument) =>
          argument.kind === "literal" ? argument.value : `<secret:${argument.reference}>`),
      ],
      cwd: operation.cwd.canonicalPath,
      environmentId: prepared.subject.environment.environmentId,
      rules: authority.execRules,
      amendments: amendments.flatMap((amendment) =>
        amendment.kind === "exec_policy" ? [amendment.amendment] : []),
    });
  }
  if (operation.kind === "network") {
    return evaluateNetworkPolicyRules({
      host: operation.endpoint.host,
      port: operation.endpoint.port,
      protocol: operation.endpoint.applicationProtocol,
      environmentId: prepared.subject.environment.environmentId,
      rules: authority.networkRules,
      amendments: amendments.flatMap((amendment) =>
        amendment.kind === "network_policy" ? [amendment.amendment] : []),
    });
  }
  return Object.freeze({ decision: "none", matchedRuleIds: Object.freeze([]) });
}

function operationTargetKeys(prepared: PreparedExternalAction): readonly string[] {
  const operation = prepared.subject.operation;
  if (operation.kind === "file_system") {
    return Object.freeze(operation.operations.flatMap((entry) =>
      "target" in entry
        ? [canonicalPathTargetKey(entry.target.path)]
        : [canonicalPathTargetKey(entry.source.path), canonicalPathTargetKey(entry.destination.path)]));
  }
  if (operation.kind === "process") {
    return Object.freeze([
      canonicalPathTargetKey(operation.executable.path),
      canonicalPathTargetKey(operation.cwd),
    ]);
  }
  if (operation.kind === "network") return Object.freeze([canonicalEndpointKey(operation.endpoint)]);
  if (operation.kind === "remote_tool") {
    return Object.freeze([canonicalRemoteToolTargetKey(operation.target)]);
  }
  return Object.freeze([`${operation.skillId}:${operation.skillVersion}:${operation.sourceFingerprint}`]);
}

function effectKind(
  kind: "file_system" | "process" | "network" | "remote_tool",
  operation: string,
): ActionPolicyEffectKind {
  if (kind === "file_system") return operation === "read" ? "file_system_read" : "file_system_write";
  if (kind === "process") return "process_spawn";
  if (kind === "network") return "network_connect";
  return "remote_tool_invoke";
}

function effectTargetKeys(
  effect: Extract<PreparedExternalAction["subject"]["effectSet"], { readonly kind: "effects" }>["values"][number],
): readonly string[] {
  if (effect.kind === "file_system") {
    return Object.freeze(effect.targets.map((target) => canonicalPathTargetKey(target.path)));
  }
  if (effect.kind === "process") return Object.freeze([canonicalPathTargetKey(effect.executable.path)]);
  if (effect.kind === "network") return Object.freeze(effect.endpoints.map(canonicalEndpointKey));
  return Object.freeze([canonicalRemoteToolTargetKey(effect.target)]);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
