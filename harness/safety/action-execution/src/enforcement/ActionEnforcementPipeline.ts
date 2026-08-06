import type { InvocationInterruptionContext, InvocationInterruptionRef } from "@agent-anything/agent-core/run";
import {
  allowsActionApproval,
  type ActionApprovalCause,
} from "@agent-anything/permission";
import type { ActionPolicyPort, PolicyDecision } from "@agent-anything/governance";
import {
  createActionExecutionFailure,
  type ActionExecutionFailure,
  type ActionExecutionFailureKind,
} from "../execution/ActionExecutionFailure.js";
import {
  type ActionAdapterImplementation,
  type ActionAdapterRevalidationResult,
  type ActionAdapterSandboxReconciliationResult,
  createActionAdapterImplementationSnapshot,
} from "../registration/ActionAdapter.js";
import {
  assertStrictRecord,
  contractError,
  validateBoundedText,
  validateToken,
} from "../canonical/ActionContractValidation.js";
import {
  type ActionRegistrationSnapshot,
} from "../registration/ActionRegistration.js";
import {
  capabilityEffectKey,
} from "../canonical/CapabilityEffect.js";
import {
  createActionFingerprint,
} from "../canonical/ActionFingerprint.js";
import {
  assertPreparedExternalAction,
  type PreparedExternalAction,
  validatePreparedAt,
} from "../preparation/PreparedExternalAction.js";
import {
  assertPreparedInvocationMatchesExecutor,
} from "../canonical/PreparedActionInvocation.js";
import {
  type ActionAssessment,
  type ActionAssessmentAuthoritySnapshot,
  type AssessPreparedActionInput,
  assertActionDispatchAuthorization,
  createActionDispatchAuthorization,
  snapshotActionAssessmentAuthority,
} from "./ActionAssessment.js";
import {
  type ActionRevalidationResult,
  type RevalidatePreparedActionInput,
  assertActionDispatchPlan,
  createActionDispatchPlan,
} from "./ActionRevalidation.js";
import {
  checkManagedActionConstraints,
  deriveActionAuthority,
} from "./ActionAuthorityAssessment.js";
import {
  assertApprovalMapping,
  createActionApprovalRequirement,
  requiredApprovalCategory,
} from "./ActionApprovalAssessment.js";
import {
  createActionPolicyInput,
  evaluatePreparedActionRules,
} from "./ActionGovernanceAssessment.js";
import { createCanonicalSha256Digest } from "../canonical/CanonicalEncoding.js";
import { assertGatewaySandboxDenial } from "../sandbox/SandboxExecutionGateway.js";
import {
  createSandboxEscalationProposal,
  type DeriveSandboxEscalationInput,
  type SandboxEscalationResult,
} from "../sandbox/SandboxEscalation.js";
import {
  assertToolActionBindingSnapshot,
  type ToolActionBindingSnapshot,
} from "../registration/ToolActionBinding.js";
import {
  ActionPreparationCoordinator,
  type ActionPreparationResult,
  type PrepareExternalActionInput,
} from "../preparation/ActionPreparationCoordinator.js";
import {
  resolveFinalActionRevalidationTarget,
  revalidatePreparedActionTarget,
} from "./FinalActionRevalidation.js";

export type {
  ActionPreparationResult,
  PrepareExternalActionInput,
} from "../preparation/ActionPreparationCoordinator.js";

export interface ActionEnforcementPipelineDependencies {
  readonly registrations: ActionRegistrationSnapshot;
  readonly toolBindings: ToolActionBindingSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly policyPort: ActionPolicyPort;
  readonly now?: () => string;
}

export class ActionEnforcementPipeline {
  private readonly adapters;
  private readonly now: () => string;
  private readonly preparation;
  private readonly processedSandboxDenials = new WeakSet<object>();

  constructor(
    private readonly dependencies: ActionEnforcementPipelineDependencies,
  ) {
    assertToolActionBindingSnapshot(dependencies.toolBindings);
    if (
      dependencies.toolBindings.actionRegistrationSnapshotId !==
      dependencies.registrations.snapshotId
    ) {
      throw new TypeError(
        "Tool Action bindings and Action registrations must belong to the same immutable snapshot.",
      );
    }
    this.adapters = createActionAdapterImplementationSnapshot(
      dependencies.registrations,
      dependencies.adapters,
    );
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.preparation = new ActionPreparationCoordinator({
      registrations: dependencies.registrations,
      toolBindings: dependencies.toolBindings,
      adapters: this.adapters,
      now: this.now,
    });
  }

  get toolBindingSnapshotId(): string {
    return this.dependencies.toolBindings.snapshotId;
  }

  async prepare(input: PrepareExternalActionInput): Promise<ActionPreparationResult> {
    return this.preparation.prepare(input);
  }

  async assess(input: AssessPreparedActionInput): Promise<ActionAssessment> {
    const before = observeAssessmentInterruption(input.interruption);
    if (before !== null) return before;

    let authority: ActionAssessmentAuthoritySnapshot;
    let expectedFingerprint: string;
    try {
      assertPreparedExternalAction(input.prepared);
      authority = snapshotActionAssessmentAuthority(input.authority);
      expectedFingerprint = await createActionFingerprint(input.prepared.subject);
    } catch {
      return assessmentFailed("tool", "tool_action_fingerprint_failed", "Prepared Action fingerprint verification failed.");
    }
    if (expectedFingerprint !== input.prepared.actionFingerprint ||
      input.prepared.subject.action.runId !== input.prepared.action.runId ||
      input.prepared.subject.action.actionId !== input.prepared.action.id) {
      return Object.freeze({
        status: "invalidated" as const,
        code: "action_prepared_subject_changed",
        message: "The prepared Action no longer matches its canonical subject.",
      });
    }

    const managed = checkManagedActionConstraints(input.prepared, authority);
    if (managed.status === "invalidated") return managed;
    if (managed.status === "denied") {
      return assessmentDenied(
        managed.code.startsWith("policy_") ? "policy" : "permission",
        managed.code,
        managed.message,
      );
    }

    const policyInput = createActionPolicyInput(input.prepared);
    let policyDecision: PolicyDecision;
    try {
      policyDecision = await this.dependencies.policyPort.evaluate(policyInput);
      assertPolicyDecision(policyDecision, policyInput.checkId);
    } catch {
      const interrupted = observeAssessmentInterruption(input.interruption);
      if (interrupted !== null) return interrupted;
      return assessmentFailed("policy", "policy_evaluation_failed", "Governance Policy evaluation failed.");
    }
    const afterPolicy = observeAssessmentInterruption(input.interruption);
    if (afterPolicy !== null) return afterPolicy;
    if (policyDecision.status === "denied") {
      return assessmentDenied(
        "policy",
        policyDecision.code ?? "policy_denied",
        policyDecision.reason ?? "Governance Policy denied the Action.",
      );
    }

    let ruleOutcome;
    try {
      ruleOutcome = evaluatePreparedActionRules(input.prepared, authority);
    } catch {
      return assessmentFailed("policy", "policy_rule_evaluation_failed", "Action Rule evaluation failed.");
    }
    if (ruleOutcome.decision === "forbidden") {
      return assessmentDenied("policy", "policy_rule_forbidden", "An applicable Rule forbids the Action.");
    }

    let derivedAuthority;
    try {
      derivedAuthority = deriveActionAuthority({ prepared: input.prepared, authority, ruleOutcome });
    } catch {
      return assessmentFailed(
        "permission",
        "permission_authority_derivation_failed",
        "Effective Action authority could not be derived.",
      );
    }

    const causes: ActionApprovalCause[] = [];
    if (policyDecision.status === "requires_review" && !derivedAuthority.hasCategoryAuthority) {
      causes.push("governance_review");
    }
    if (ruleOutcome.decision === "prompt" && !derivedAuthority.hasCategoryAuthority) {
      causes.push("rule_prompt");
    }
    if (!derivedAuthority.fullyCovered) causes.push("missing_authority");

    try {
      assertApprovalMapping({
        prepared: input.prepared,
        requiredForReview: causes.length > 0 || input.prepared.approvalCategory !== null,
        missingPermissions: derivedAuthority.missingPermissions,
      });
    } catch (error) {
      return assessmentDenied(
        "tool",
        "action_review_category_unsupported",
        safeValidationMessage(error, "The Action has no valid approval mapping."),
      );
    }

    if (causes.length > 0) {
      const category = input.prepared.approvalCategory ?? requiredApprovalCategory(input.prepared);
      if (causes.some((cause) => !allowsActionApproval({
        policy: authority.approvalPolicy,
        category,
        cause,
      }))) {
        return assessmentDenied(
          "permission",
          "permission_approval_not_allowed",
          "The active Approval Policy does not allow the required authority request.",
        );
      }
      try {
        return Object.freeze({
          status: "approval_required" as const,
          requirement: createActionApprovalRequirement({
            prepared: input.prepared,
            authority,
            derivedAuthority,
            causes,
          }),
          reviewContext: Object.freeze({
            ruleOutcome: ruleOutcome.decision,
            currentAuthority: Object.freeze({
              fileSystemRead: derivedAuthority.effectivePermissions.fileSystem.read.kind !== "none",
              fileSystemWrite: derivedAuthority.effectivePermissions.fileSystem.write.kind !== "none",
              network: derivedAuthority.effectivePermissions.network.connect.kind !== "none",
            }),
          }),
        });
      } catch {
        return assessmentFailed(
          "permission",
          "approval_requirement_creation_failed",
          "The trusted approval requirement could not be created.",
        );
      }
    }

    try {
      const authorizedAt = validatePreparedAt(this.now());
      const authoritySnapshotId = await createCanonicalSha256Digest(
        "agent-anything.action-authority.v1",
        {
          actionFingerprint: input.prepared.actionFingerprint,
          profileId: authority.profile.id,
          managedConstraintSetId: authority.managedConstraints.constraintSetId,
          policyCheckId: policyDecision.checkId,
          policyStatus: policyDecision.status,
          ruleOutcome,
          authoritySources: derivedAuthority.sources,
          actionCoverageIdToConsume: derivedAuthority.actionCoverageIdToConsume,
          effectivePermissions: derivedAuthority.effectivePermissions,
        },
      );
      return Object.freeze({
        status: "authorized" as const,
        authorization: createActionDispatchAuthorization({
          prepared: input.prepared,
          authoritySnapshotId,
          policyDecision,
          ruleOutcome,
          authoritySources: derivedAuthority.sources,
          actionCoverageIdToConsume: derivedAuthority.actionCoverageIdToConsume,
          effectivePermissions: derivedAuthority.effectivePermissions,
          authorizedAt,
        }),
      });
    } catch {
      return assessmentFailed(
        "permission",
        "permission_authorization_creation_failed",
        "Action dispatch authorization could not be created.",
      );
    }
  }

  async revalidate(
    input: RevalidatePreparedActionInput,
  ): Promise<ActionRevalidationResult> {
    const before = observeRevalidationInterruption(input.interruption);
    if (before !== null) return before;

    try {
      assertPreparedExternalAction(input.prepared);
      assertActionDispatchAuthorization(input.authorization);
    } catch {
      return revalidationInvalidated(
        "action_revalidation_authorization_invalid",
        "Final revalidation requires the original trusted prepared Action and authorization.",
      );
    }
    if (
      input.attemptOrdinal !== 1 && input.attemptOrdinal !== 2
    ) {
      return revalidationInvalidated(
        "action_attempt_ordinal_invalid",
        "The Action attempt ordinal is invalid.",
      );
    }
    if (
      input.authorization.runId !== input.prepared.action.runId ||
      input.authorization.actionId !== input.prepared.action.id ||
      input.authorization.actionFingerprint !== input.prepared.actionFingerprint
    ) {
      return revalidationInvalidated(
        "action_revalidation_authorization_mismatch",
        "The prior authorization does not belong to this prepared Action.",
      );
    }

    const targetResult = resolveFinalActionRevalidationTarget({
      prepared: input.prepared,
      registrations: this.dependencies.registrations,
      adapters: this.adapters,
    });
    if (targetResult.status === "invalidated") {
      return revalidationInvalidated(targetResult.code, targetResult.message);
    }
    const { registration } = targetResult.target;

    const reassessment = await this.assess({
      prepared: input.prepared,
      authority: input.authority,
      interruption: input.interruption,
    });
    if (reassessment.status !== "authorized") return reassessment;

    const beforeTarget = observeRevalidationInterruption(input.interruption);
    if (beforeTarget !== null) return beforeTarget;

    let adapterResult: ActionAdapterRevalidationResult;
    try {
      adapterResult = await revalidatePreparedActionTarget(
        targetResult.target,
        input.prepared,
        input.interruption,
      );
    } catch {
      const interrupted = observeRevalidationInterruption(input.interruption);
      if (interrupted !== null) return interrupted;
      return revalidationFailed(
        "tool",
        "tool_action_revalidation_failed",
        "The Action adapter failed during final target-state revalidation.",
        false,
      );
    }

    const afterTarget = observeRevalidationInterruption(input.interruption);
    if (afterTarget !== null) return afterTarget;

    try {
      assertAdapterRevalidationResult(adapterResult);
      if (adapterResult.status === "invalidated") {
        return revalidationInvalidated(
          validateToken(adapterResult.code, "adapterRevalidation.code"),
          validateBoundedText(
            adapterResult.message,
            "adapterRevalidation.message",
            "canonical_contract_invalid",
          ),
        );
      }
      if (adapterResult.status === "failed") {
        return revalidationFailed(
          "tool",
          validateToolFailureCode(adapterResult.code),
          validateBoundedText(
            adapterResult.message,
            "adapterRevalidation.message",
            "canonical_contract_invalid",
          ),
          assertBoolean(adapterResult.retryable, "adapterRevalidation.retryable"),
        );
      }
      if (adapterResult.status === "interrupted") {
        return Object.freeze({
          status: "interrupted" as const,
          interruption: snapshotInterruption(adapterResult.interruption),
        });
      }

      const revalidatedAt = validatePreparedAt(this.now());
      return Object.freeze({
        status: "ready" as const,
        plan: await createActionDispatchPlan({
          prepared: input.prepared,
          authorization: reassessment.authorization,
          registration,
          attemptOrdinal: input.attemptOrdinal,
          revalidatedAt,
        }),
      });
    } catch {
      const interrupted = observeRevalidationInterruption(input.interruption);
      if (interrupted !== null) return interrupted;
      return revalidationFailed(
        "tool",
        "tool_action_revalidation_contract_invalid",
        "The Action adapter returned invalid final revalidation data.",
        false,
      );
    }
  }

  async deriveEscalation(
    input: DeriveSandboxEscalationInput,
  ): Promise<SandboxEscalationResult> {
    const before = observeEscalationInterruption(input.interruption);
    if (before !== null) return before;
    try {
      assertPreparedExternalAction(input.prepared);
      assertActionDispatchPlan(input.plan);
      assertGatewaySandboxDenial(input.denial);
    } catch {
      return escalationFailed(
        "sandbox_escalation_provenance_invalid",
        "Sandbox escalation requires the original prepared Action, dispatch plan, and gateway denial.",
      );
    }
    if (
      input.plan.runId !== input.prepared.action.runId ||
      input.plan.actionId !== input.prepared.action.id ||
      input.plan.actionFingerprint !== input.prepared.actionFingerprint ||
      input.plan.preparedInvocationDigest !==
        input.prepared.subject.preparedInvocationDigest ||
      input.denial.runId !== input.plan.runId ||
      input.denial.actionId !== input.plan.actionId ||
      input.denial.actionFingerprint !== input.plan.actionFingerprint ||
      input.denial.ordinal !== input.plan.attemptOrdinal ||
      input.denial.attemptId.length === 0
    ) {
      return escalationFailed(
        "sandbox_escalation_correlation_invalid",
        "Sandbox denial does not correlate to the exact prepared Action and attempt.",
      );
    }
    if (this.processedSandboxDenials.has(input.denial)) {
      return escalationIneligible(
        "sandbox_escalation_already_processed",
        "The sandbox denial has already completed its escalation decision.",
      );
    }
    this.processedSandboxDenials.add(input.denial);
    if (
      input.plan.enforcement === "disabled" ||
      input.plan.attemptOrdinal !== 1 ||
      input.denial.ordinal !== 1
    ) {
      return escalationIneligible(
        "sandbox_escalation_attempt_ineligible",
        "Only the first managed or external sandbox attempt can propose escalation.",
      );
    }
    if (input.denial.effectState !== "none") {
      return escalationIneligible(
        "sandbox_escalation_effect_state_unknown",
        "Sandbox escalation requires proof that the denied attempt produced no effect.",
      );
    }
    if (
      input.denial.deniedEffect.kind !== "file_system" &&
      input.denial.deniedEffect.kind !== "network"
    ) {
      return escalationIneligible(
        "sandbox_escalation_effect_unsupported",
        "The denied effect cannot be represented by bounded additional permissions.",
      );
    }
    if (
      input.prepared.subject.effectSet.kind === "effects" &&
      input.prepared.subject.effectSet.values.some(
        (effect) => capabilityEffectKey(effect) ===
          capabilityEffectKey(input.denial.deniedEffect),
      )
    ) {
      return escalationIneligible(
        "sandbox_escalation_effect_already_authorized",
        "The denied effect was already declared and authorized by the previous Action subject.",
      );
    }

    const escalationTarget = resolveFinalActionRevalidationTarget({
      prepared: input.prepared,
      registrations: this.dependencies.registrations,
      adapters: this.adapters,
    });
    if (escalationTarget.status === "invalidated") {
      return Object.freeze({
        status: "invalidated" as const,
        code: "action_registration_changed",
        message: "The Action registration changed before sandbox escalation.",
      });
    }
    const { adapter } = escalationTarget.target;
    if (adapter.reconcileSandboxDenial === undefined) {
      return escalationIneligible(
        "sandbox_escalation_adapter_unsupported",
        "The registered Action adapter does not support sandbox-denial reconciliation.",
      );
    }

    const context = Object.freeze({
      workspace: input.prepared.subject.workspace,
      actor: input.prepared.subject.identity,
      environment: input.prepared.subject.environment,
      interruption: input.interruption,
    });
    let targetResult: ActionAdapterRevalidationResult;
    try {
      targetResult = await revalidatePreparedActionTarget(
        escalationTarget.target,
        input.prepared,
        input.interruption,
      );
    } catch {
      const interrupted = observeEscalationInterruption(input.interruption);
      return interrupted ?? escalationFailed(
        "tool_action_revalidation_failed",
        "The Action adapter failed while validating the first-attempt target state.",
        "tool",
      );
    }
    const afterTarget = observeEscalationInterruption(input.interruption);
    if (afterTarget !== null) return afterTarget;
    try {
      assertAdapterRevalidationResult(targetResult);
      if (targetResult.status === "invalidated") {
        return Object.freeze({
          status: "invalidated" as const,
          code: validateToken(targetResult.code, "adapterRevalidation.code"),
          message: validateBoundedText(
            targetResult.message,
            "adapterRevalidation.message",
            "canonical_contract_invalid",
          ),
        });
      }
      if (targetResult.status === "failed") {
        return escalationFailed(
          validateToolFailureCode(targetResult.code),
          validateBoundedText(
            targetResult.message,
            "adapterRevalidation.message",
            "canonical_contract_invalid",
          ),
          "tool",
          assertBoolean(targetResult.retryable, "adapterRevalidation.retryable"),
        );
      }
      if (targetResult.status === "interrupted") {
        return Object.freeze({
          status: "interrupted" as const,
          interruption: snapshotInterruption(targetResult.interruption),
        });
      }
    } catch {
      return escalationFailed(
        "tool_action_revalidation_contract_invalid",
        "The Action adapter returned invalid target-state revalidation data.",
        "tool",
      );
    }

    let reconciliation: ActionAdapterSandboxReconciliationResult;
    try {
      reconciliation = await adapter.reconcileSandboxDenial(
        input.prepared.preparedInvocation,
        input.denial.deniedEffect,
        input.prepared.subject.targetAssertions,
        context,
      );
    } catch {
      const interrupted = observeEscalationInterruption(input.interruption);
      return interrupted ?? escalationFailed(
        "tool_sandbox_reconciliation_failed",
        "The Action adapter failed while reconciling the denied effect.",
        "tool",
      );
    }
    const afterReconciliation = observeEscalationInterruption(input.interruption);
    if (afterReconciliation !== null) return afterReconciliation;
    try {
      assertAdapterSandboxReconciliationResult(reconciliation);
      if (reconciliation.status === "unsupported") {
        return escalationIneligible(
          validateToken(reconciliation.code, "adapterReconciliation.code"),
          validateBoundedText(
            reconciliation.message,
            "adapterReconciliation.message",
            "canonical_contract_invalid",
          ),
        );
      }
      if (reconciliation.status === "invalidated") {
        return Object.freeze({
          status: "invalidated" as const,
          code: validateToken(reconciliation.code, "adapterReconciliation.code"),
          message: validateBoundedText(
            reconciliation.message,
            "adapterReconciliation.message",
            "canonical_contract_invalid",
          ),
        });
      }
      if (reconciliation.status === "failed") {
        return escalationFailed(
          validateToolFailureCode(reconciliation.code),
          validateBoundedText(
            reconciliation.message,
            "adapterReconciliation.message",
            "canonical_contract_invalid",
          ),
          "tool",
          assertBoolean(reconciliation.retryable, "adapterReconciliation.retryable"),
        );
      }
      if (reconciliation.status === "interrupted") {
        return Object.freeze({
          status: "interrupted" as const,
          interruption: snapshotInterruption(reconciliation.interruption),
        });
      }
      return createSandboxEscalationProposal({
        prepared: input.prepared,
        plan: input.plan,
        denial: input.denial,
        additionalAssertions: reconciliation.targetAssertions,
        preparedAt: validatePreparedAt(this.now()),
      });
    } catch {
      return escalationFailed(
        "tool_sandbox_reconciliation_contract_invalid",
        "The Action adapter returned invalid sandbox reconciliation data.",
        "tool",
      );
    }
  }
}

function assertAdapterRevalidationResult(
  input: ActionAdapterRevalidationResult,
): void {
  if (input?.status === "valid") {
    assertStrictRecord(
      input,
      "adapterRevalidation",
      new Set(["status"]),
      "canonical_contract_invalid",
    );
    return;
  }
  if (input?.status === "invalidated") {
    assertStrictRecord(
      input,
      "adapterRevalidation",
      new Set(["status", "code", "message"]),
      "canonical_contract_invalid",
    );
    return;
  }
  if (input?.status === "failed") {
    assertStrictRecord(
      input,
      "adapterRevalidation",
      new Set(["status", "code", "message", "retryable"]),
      "canonical_contract_invalid",
    );
    return;
  }
  if (input?.status === "interrupted") {
    assertStrictRecord(
      input,
      "adapterRevalidation",
      new Set(["status", "interruption"]),
      "canonical_contract_invalid",
    );
    return;
  }
  throw new TypeError("Unknown Action adapter revalidation result.");
}

function assertAdapterSandboxReconciliationResult(
  input: ActionAdapterSandboxReconciliationResult,
): void {
  if (input?.status === "supported") {
    assertStrictRecord(
      input,
      "adapterReconciliation",
      new Set(["status", "targetAssertions"]),
      "canonical_contract_invalid",
    );
    if (!Array.isArray(input.targetAssertions)) {
      throw new TypeError("Adapter reconciliation targetAssertions must be an array.");
    }
    return;
  }
  if (input?.status === "unsupported" || input?.status === "invalidated") {
    assertStrictRecord(
      input,
      "adapterReconciliation",
      new Set(["status", "code", "message"]),
      "canonical_contract_invalid",
    );
    return;
  }
  if (input?.status === "failed") {
    assertStrictRecord(
      input,
      "adapterReconciliation",
      new Set(["status", "code", "message", "retryable"]),
      "canonical_contract_invalid",
    );
    return;
  }
  if (input?.status === "interrupted") {
    assertStrictRecord(
      input,
      "adapterReconciliation",
      new Set(["status", "interruption"]),
      "canonical_contract_invalid",
    );
    return;
  }
  throw new TypeError("Unknown Action adapter sandbox reconciliation result.");
}

function observeEscalationInterruption(
  context: InvocationInterruptionContext,
): SandboxEscalationResult | null {
  const observed = observeRevalidationInterruption(context);
  if (observed === null) return null;
  if (observed.status === "interrupted" || observed.status === "failed") {
    return observed;
  }
  throw new Error("Unexpected revalidation interruption result.");
}

function escalationIneligible(code: string, message: string): SandboxEscalationResult {
  return Object.freeze({ status: "ineligible" as const, code, message });
}

function escalationFailed(
  code: string,
  message: string,
  owner: ActionExecutionFailureKind = "sandbox",
  retryable = false,
): SandboxEscalationResult {
  return Object.freeze({
    status: "failed" as const,
    failure: pipelineFailure(owner, code, message, retryable),
  });
}

function observeRevalidationInterruption(
  context: InvocationInterruptionContext,
): ActionRevalidationResult | null {
  if (!context.signal.aborted) return null;
  if (context.interruption === null) {
    return revalidationFailed(
      "action_execution",
      "runtime_action_revalidation_interruption_unattributed",
      "Action revalidation was aborted without interruption attribution.",
      false,
    );
  }
  try {
    return Object.freeze({
      status: "interrupted" as const,
      interruption: snapshotInterruption(context.interruption),
    });
  } catch {
    return revalidationFailed(
      "action_execution",
      "runtime_action_revalidation_interruption_invalid",
      "Action revalidation interruption attribution is invalid.",
      false,
    );
  }
}

function revalidationInvalidated(
  code: string,
  message: string,
): ActionRevalidationResult {
  return Object.freeze({ status: "invalidated" as const, code, message });
}

function revalidationFailed(
  owner: ActionExecutionFailureKind,
  code: string,
  message: string,
  retryable: boolean,
): ActionRevalidationResult {
  return Object.freeze({
    status: "failed" as const,
    failure: pipelineFailure(owner, code, message, retryable),
  });
}

function assertPolicyDecision(input: PolicyDecision, expectedCheckId: string): void {
  if (!input || input.checkId !== expectedCheckId ||
    (input.status !== "allowed" && input.status !== "denied" && input.status !== "requires_review") ||
    typeof input.decidedAt !== "string" || Number.isNaN(Date.parse(input.decidedAt))) {
    throw new TypeError("Policy returned an invalid decision.");
  }
}

function observeAssessmentInterruption(
  context: InvocationInterruptionContext,
): ActionAssessment | null {
  if (!context.signal.aborted) return null;
  if (context.interruption === null) {
    return assessmentFailed(
      "action_execution",
      "runtime_action_assessment_interruption_unattributed",
      "Action assessment was aborted without interruption attribution.",
    );
  }
  try {
    return Object.freeze({ status: "interrupted" as const, interruption: snapshotInterruption(context.interruption) });
  } catch {
    return assessmentFailed(
      "action_execution",
      "runtime_action_assessment_interruption_invalid",
      "Action assessment interruption attribution is invalid.",
    );
  }
}

function assessmentDenied(
  owner: "policy" | "permission" | "tool",
  code: string,
  message: string,
): ActionAssessment {
  return Object.freeze({ status: "denied" as const, owner, code, message });
}

function assessmentFailed(
  owner: ActionExecutionFailureKind,
  code: string,
  message: string,
): ActionAssessment {
  return Object.freeze({
    status: "failed" as const,
    failure: pipelineFailure(owner, code, message, false),
  });
}

function snapshotInterruption(input: InvocationInterruptionRef): InvocationInterruptionRef {
  if (input?.kind === "run_cancellation") {
    assertStrictRecord(
      input,
      "interruption",
      new Set(["kind", "cancellation"]),
      "canonical_contract_invalid",
    );
    assertStrictRecord(
      input.cancellation,
      "interruption.cancellation",
      new Set(["runId", "requestId"]),
      "canonical_contract_invalid",
    );
    return Object.freeze({
      kind: "run_cancellation" as const,
      cancellation: Object.freeze({
        runId: validateToken(input.cancellation.runId, "interruption.cancellation.runId"),
        requestId: validateToken(input.cancellation.requestId, "interruption.cancellation.requestId"),
      }),
    });
  }
  if (input?.kind === "operation_deadline") {
    assertStrictRecord(
      input,
      "interruption",
      new Set(["kind", "deadline"]),
      "canonical_contract_invalid",
    );
    assertStrictRecord(
      input.deadline,
      "interruption.deadline",
      new Set(["operationId", "deadlineAt"]),
      "canonical_contract_invalid",
    );
    return Object.freeze({
      kind: "operation_deadline" as const,
      deadline: Object.freeze({
        operationId: validateToken(input.deadline.operationId, "interruption.deadline.operationId"),
        deadlineAt: validatePreparedAt(input.deadline.deadlineAt),
      }),
    });
  }
  throw contractError(
    "canonical_contract_invalid",
    "Unknown Action preparation interruption.",
    "interruption.kind",
  );
}

function assertBoolean(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") {
    throw contractError("canonical_contract_invalid", `A boolean is required at ${path}.`, path);
  }
  return input;
}

function validateToolFailureCode(input: unknown): string {
  const code = validateToken(input, "adapterResult.code");
  if (!code.startsWith("tool_")) {
    throw contractError(
      "canonical_contract_invalid",
      "Action adapter failure codes must belong to the tool owner.",
      "adapterResult.code",
    );
  }
  return code;
}

function pipelineFailure(
  kind: ActionExecutionFailureKind,
  code: string,
  message: string,
  retryable: boolean,
): ActionExecutionFailure {
  const failure = Object.freeze({
    code,
    message,
    retryable,
    metadata: Object.freeze({}),
  });

  switch (kind) {
    case "action_execution":
      return createActionExecutionFailure("action_execution", failure);
    case "policy":
      return createActionExecutionFailure("policy", failure);
    case "permission":
      return createActionExecutionFailure("permission", failure);
    case "tool":
      return createActionExecutionFailure("tool", failure);
    case "sandbox":
      return createActionExecutionFailure("sandbox", Object.freeze({
        ...failure,
        effectState: "none" as const,
      }));
  }
}

function safeValidationMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 8_192) {
    return error.message;
  }
  return fallback;
}
