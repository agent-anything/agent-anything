import {
  snapshotApprovalPayload,
  type ApprovalCategory,
  type ApprovalPayloadByCategory,
  type CanonicalAdditionalPermissions,
} from "@agent-anything/permission";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/shared";
import type { RuntimeError } from "../run/RuntimeError.js";
import type { ActionDispatchPlan } from "./ActionRevalidation.js";
import type { CanonicalPathIdentity } from "./CanonicalIdentity.js";
import { assertCanonicalActionCoherence } from "./CanonicalActionCoherence.js";
import {
  addCapabilityEffect,
  capabilityEffectKey,
  type CapabilityEffect,
} from "./CapabilityEffect.js";
import { createActionFingerprint } from "./ActionFingerprint.js";
import {
  createCanonicalActionSubject,
  createPreparedExternalAction,
  snapshotCanonicalAdditionalPermissions,
  type PreparedExternalAction,
} from "./PreparedExternalAction.js";
import type { SandboxDenial } from "./SandboxContracts.js";
import {
  mergeTargetStateAssertions,
  targetStateAssertionKey,
  type TargetStateAssertion,
  type TargetStateAssertionInput,
} from "./TargetStateAssertion.js";

export interface DeriveSandboxEscalationInput {
  readonly prepared: PreparedExternalAction;
  readonly plan: ActionDispatchPlan;
  readonly denial: SandboxDenial;
  readonly interruption: InvocationInterruptionContext;
}

export interface SandboxEscalationProposal {
  readonly previousAttemptId: string;
  readonly previousActionFingerprint: string;
  readonly prepared: PreparedExternalAction;
  readonly additionalPermissions: CanonicalAdditionalPermissions;
  readonly nextAttemptOrdinal: 2;
}

export type SandboxEscalationResult =
  | { readonly status: "eligible"; readonly proposal: SandboxEscalationProposal }
  | { readonly status: "ineligible"; readonly code: string; readonly message: string }
  | { readonly status: "invalidated"; readonly code: string; readonly message: string }
  | { readonly status: "failed"; readonly error: RuntimeError }
  | { readonly status: "interrupted"; readonly interruption: InvocationInterruptionRef };

export interface CreateSandboxEscalationProposalInput {
  readonly prepared: PreparedExternalAction;
  readonly plan: ActionDispatchPlan;
  readonly denial: SandboxDenial;
  readonly additionalAssertions: readonly TargetStateAssertionInput[];
  readonly preparedAt: string;
}

export async function createSandboxEscalationProposal(
  input: CreateSandboxEscalationProposalInput,
): Promise<SandboxEscalationResult> {
  const delta = derivePermissionDelta(input.denial.deniedEffect);
  if (delta === null) {
    return ineligible(
      "sandbox_escalation_effect_unsupported",
      "The denied effect cannot be represented by bounded additional permissions.",
    );
  }
  if (effectAlreadyDeclared(input.prepared, input.denial.deniedEffect)) {
    return ineligible(
      "sandbox_escalation_effect_already_authorized",
      "The denied effect was already declared and authorized by the previous Action subject.",
    );
  }
  const category = input.prepared.approvalCategory;
  const payload = input.prepared.approvalPayload;
  if (category === null || payload === null || !supportsPermissionPayload(category)) {
    return ineligible(
      "sandbox_escalation_approval_mapping_unsupported",
      "The Action approval category cannot express the additional permission delta.",
    );
  }

  try {
    const additionalPermissions = snapshotCanonicalAdditionalPermissions(
      delta,
      input.prepared.subject.environment,
    );
    if (additionalPermissions === null) {
      return ineligible(
        "sandbox_escalation_permission_delta_empty",
        "The denied effect produced no additional permission delta.",
      );
    }
    const requestedPermissions = mergePermissions(
      input.prepared.subject.requestedPermissions,
      additionalPermissions,
      input.prepared.subject.environment,
    );
    const effectSet = addCapabilityEffect(
      input.prepared.subject.effectSet,
      input.denial.deniedEffect,
    );
    const targetAssertions = mergeTargetStateAssertions(
      input.prepared.subject.targetAssertions,
      input.additionalAssertions,
    );
    assertRequiredAssertions(input.denial.deniedEffect, targetAssertions);
    const approvalPayload = updateApprovalPayload(
      category,
      payload,
      requestedPermissions,
    );
    const subject = createCanonicalActionSubject({
      action: input.prepared.action,
      registration: input.plan.registration,
      workspace: input.prepared.subject.workspace,
      actor: input.prepared.subject.identity,
      environment: input.prepared.subject.environment,
      operation: input.prepared.subject.operation,
      effectSet,
      requestedPermissions,
      approvalCategory: category,
      applicabilityKeys: input.prepared.applicabilityKeys,
      preparedInvocationDigest: input.prepared.subject.preparedInvocationDigest,
      targetAssertions,
    });
    assertCanonicalActionCoherence({
      operation: subject.operation,
      effectSet: subject.effectSet,
      targetAssertions: subject.targetAssertions,
    });
    const actionFingerprint = await createActionFingerprint(subject);
    if (actionFingerprint === input.prepared.actionFingerprint) {
      return ineligible(
        "sandbox_escalation_fingerprint_unchanged",
        "Sandbox escalation did not change the canonical Action subject.",
      );
    }
    const prepared = createPreparedExternalAction({
      action: input.prepared.action,
      subject,
      actionFingerprint,
      safeSummary: input.prepared.safeSummary,
      approvalPayload,
      preparedInvocation: input.prepared.preparedInvocation,
      preparedAt: input.preparedAt,
    });
    return Object.freeze({
      status: "eligible" as const,
      proposal: Object.freeze({
        previousAttemptId: input.denial.attemptId,
        previousActionFingerprint: input.prepared.actionFingerprint,
        prepared,
        additionalPermissions,
        nextAttemptOrdinal: 2 as const,
      }),
    });
  } catch (error) {
    return Object.freeze({
      status: "failed" as const,
      error: runtimeError(
        "sandbox_escalation_contract_invalid",
        error instanceof Error
          ? error.message
          : "Sandbox escalation contract construction failed.",
      ),
    });
  }
}

function derivePermissionDelta(
  effect: CapabilityEffect,
): CanonicalAdditionalPermissions | null {
  if (effect.kind === "file_system") {
    const paths = effect.targets
      .map((target) => target.path.resolvedPath ?? target.path.canonicalPath)
      .sort(compareStrings);
    return Object.freeze({
      fileSystem: Object.freeze({
        [effect.operation]: Object.freeze([...new Set(paths)]),
      }),
    });
  }
  if (effect.kind === "network") {
    const domains = effect.endpoints.map((endpoint) => endpoint.host).sort(compareStrings);
    return Object.freeze({
      network: Object.freeze({
        enabled: true as const,
        domains: Object.freeze([...new Set(domains)]),
      }),
    });
  }
  return null;
}

function mergePermissions(
  current: CanonicalAdditionalPermissions | null,
  delta: CanonicalAdditionalPermissions,
  environment: PreparedExternalAction["subject"]["environment"],
): CanonicalAdditionalPermissions {
  const read = union(
    current?.fileSystem?.read ?? [],
    delta.fileSystem?.read ?? [],
  );
  const write = union(
    current?.fileSystem?.write ?? [],
    delta.fileSystem?.write ?? [],
  );
  const currentNetwork = current?.network;
  const deltaNetwork = delta.network;
  const networkEnabled = currentNetwork?.enabled === true || deltaNetwork?.enabled === true;
  const unrestrictedNetwork = networkEnabled &&
    ((currentNetwork?.enabled === true && currentNetwork.domains === undefined) ||
      (deltaNetwork?.enabled === true && deltaNetwork.domains === undefined));
  const domains = unrestrictedNetwork
    ? []
    : union(currentNetwork?.domains ?? [], deltaNetwork?.domains ?? []);
  const merged: CanonicalAdditionalPermissions = {
    ...(read.length === 0 && write.length === 0
      ? {}
      : {
          fileSystem: {
            ...(read.length === 0 ? {} : { read }),
            ...(write.length === 0 ? {} : { write }),
          },
        }),
    ...(networkEnabled
      ? {
          network: {
            enabled: true as const,
            ...(unrestrictedNetwork ? {} : { domains }),
          },
        }
      : {}),
  };
  const snapshot = snapshotCanonicalAdditionalPermissions(merged, environment);
  if (snapshot === null) throw new TypeError("Merged escalation permissions are empty.");
  return snapshot;
}

function updateApprovalPayload(
  category: Extract<ApprovalCategory, "commandExecution" | "fileChange" | "permissions" | "skill">,
  payload: ApprovalPayloadByCategory[ApprovalCategory],
  permissions: CanonicalAdditionalPermissions,
): ApprovalPayloadByCategory[ApprovalCategory] {
  switch (category) {
    case "commandExecution":
      return snapshotApprovalPayload(category, {
        ...(payload as ApprovalPayloadByCategory["commandExecution"]),
        additionalPermissions: permissions,
      });
    case "fileChange":
      return snapshotApprovalPayload(category, {
        ...(payload as ApprovalPayloadByCategory["fileChange"]),
        additionalPermissions: permissions,
      });
    case "permissions":
      return snapshotApprovalPayload(category, {
        ...(payload as ApprovalPayloadByCategory["permissions"]),
        permissions,
      });
    case "skill":
      return snapshotApprovalPayload(category, {
        ...(payload as ApprovalPayloadByCategory["skill"]),
        requiredPermissions: permissions,
      });
  }
}

function assertRequiredAssertions(
  effect: CapabilityEffect,
  assertions: readonly TargetStateAssertion[],
): void {
  if (effect.kind !== "file_system") return;
  const keys = new Set(assertions.map(targetStateAssertionKey));
  for (const target of effect.targets) {
    const targetKey = targetStateKey(target.path);
    if (!keys.has(`canonical_path_identity:${targetKey}`)) {
      throw new TypeError("Filesystem escalation requires a canonical path identity assertion.");
    }
    if (effect.operation === "write" && !keys.has(`file_baseline:${targetKey}`)) {
      throw new TypeError("Filesystem write escalation requires a file baseline assertion.");
    }
  }
}

function targetStateKey(path: CanonicalPathIdentity): string {
  return `${path.platform}:${path.resolvedComparisonKey ?? path.comparisonKey}`;
}

function effectAlreadyDeclared(
  prepared: PreparedExternalAction,
  deniedEffect: CapabilityEffect,
): boolean {
  return prepared.subject.effectSet.kind === "effects" &&
    prepared.subject.effectSet.values.some(
      (effect) => capabilityEffectKey(effect) === capabilityEffectKey(deniedEffect),
    );
}

function supportsPermissionPayload(
  category: ApprovalCategory,
): category is Extract<ApprovalCategory, "commandExecution" | "fileChange" | "permissions" | "skill"> {
  return category === "commandExecution" ||
    category === "fileChange" ||
    category === "permissions" ||
    category === "skill";
}

function union(left: readonly string[], right: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...left, ...right])].sort(compareStrings));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ineligible(code: string, message: string): SandboxEscalationResult {
  return Object.freeze({ status: "ineligible" as const, code, message });
}

function runtimeError(code: string, message: string): RuntimeError {
  return Object.freeze({
    owner: "sandbox" as const,
    code,
    message,
    retryable: false,
    metadata: Object.freeze({}),
  });
}
