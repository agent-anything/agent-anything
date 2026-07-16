import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
  ISODateTimeString,
} from "@agent-anything/shared";
import { snapshotApprovalPayload } from "@agent-anything/permission/approval";
import {
  allowsActionApproval,
  type ActionApprovalCause,
} from "@agent-anything/permission";
import type { ActionPolicyPort, PolicyDecision } from "@agent-anything/governance";
import type { Action } from "../runner/Action.js";
import type { ActionRejectedCode } from "../runner/Observation.js";
import type { RuntimeError } from "../runner/RuntimeError.js";
import {
  type ActionAdapterImplementation,
  type ActionAdapterPreparationResult,
  createActionAdapterImplementationSnapshot,
} from "./ActionAdapter.js";
import {
  assertStrictRecord,
  contractError,
  validateBoundedText,
  validateToken,
} from "./ActionContractValidation.js";
import {
  findActionRegistration,
  type ActionRegistrationSnapshot,
} from "./ActionRegistration.js";
import { createCanonicalActionOperation } from "./CanonicalActionOperation.js";
import { assertCanonicalActionCoherence } from "./CanonicalActionCoherence.js";
import {
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalWorkspaceIdentity,
  type CanonicalActorIdentity,
  type CanonicalEnvironmentIdentityInput,
  type CanonicalWorkspaceIdentityInput,
} from "./CanonicalIdentity.js";
import { createActionEffectSet } from "./CapabilityEffect.js";
import {
  createActionFingerprint,
  createPreparedInvocationDigest,
} from "./ActionFingerprint.js";
import {
  createApprovalApplicabilityKeys,
  assertPreparedExternalAction,
  createCanonicalActionSubject,
  createPreparedExternalAction,
  createPreparedActionReference,
  snapshotCanonicalAdditionalPermissions,
  type PreparedExternalAction,
  validateApprovalCategory,
  validatePreparedAt,
} from "./PreparedExternalAction.js";
import {
  assertPreparedInvocationMatchesExecutor,
  createPreparedActionInvocation,
} from "./PreparedActionInvocation.js";
import { createSafeActionSummary } from "./SafeActionSummary.js";
import { createTargetStateAssertions } from "./TargetStateAssertion.js";
import {
  type ActionAssessment,
  type ActionAssessmentAuthoritySnapshot,
  type AssessPreparedActionInput,
  createActionDispatchAuthorization,
  snapshotActionAssessmentAuthority,
} from "./ActionAssessment.js";
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
import { createCanonicalSha256Digest } from "./CanonicalEncoding.js";

export interface PrepareExternalActionInput {
  readonly action: Action;
  readonly workspace: CanonicalWorkspaceIdentityInput;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentityInput;
  readonly interruption: InvocationInterruptionContext;
}

export type ActionPreparationResult =
  | { readonly status: "prepared"; readonly prepared: PreparedExternalAction }
  | { readonly status: "rejected"; readonly code: ActionRejectedCode; readonly message: string }
  | { readonly status: "failed"; readonly error: RuntimeError }
  | { readonly status: "interrupted"; readonly interruption: InvocationInterruptionRef };

export interface ActionEnforcementPipelineDependencies {
  readonly registrations: ActionRegistrationSnapshot;
  readonly adapters: readonly ActionAdapterImplementation[];
  readonly policyPort: ActionPolicyPort;
  readonly now?: () => ISODateTimeString;
}

export class ActionEnforcementPipeline {
  private readonly adapters;
  private readonly now: () => ISODateTimeString;

  constructor(
    private readonly dependencies: ActionEnforcementPipelineDependencies,
  ) {
    this.adapters = createActionAdapterImplementationSnapshot(
      dependencies.registrations,
      dependencies.adapters,
    );
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async prepare(input: PrepareExternalActionInput): Promise<ActionPreparationResult> {
    let action;
    try {
      action = createPreparedActionReference(input.action);
    } catch (error) {
      return rejected(
        hasDataProperty(input.action, "kind") && input.action.kind !== "tool"
          ? "action_unsupported"
          : "action_invalid",
        safeValidationMessage(error, "The Action is invalid."),
      );
    }

    const registration = findActionRegistration(
      this.dependencies.registrations,
      action.name,
    );
    if (registration === undefined) {
      return rejected("tool_not_found", `No trusted Action registration exists for '${action.name}'.`);
    }
    const adapter = this.adapters.find(action.name);
    if (adapter === undefined) {
      return failed(
        "tool_action_adapter_unavailable",
        "The registered Action adapter is unavailable.",
        false,
      );
    }

    let context;
    try {
      context = Object.freeze({
        workspace: createCanonicalWorkspaceIdentity(input.workspace),
        actor: createCanonicalActorIdentity(input.actor),
        environment: createCanonicalEnvironmentIdentity(input.environment),
        interruption: input.interruption,
      });
      assertInterruptionContext(input.interruption);
    } catch (error) {
      return failed(
        "tool_action_preparation_context_invalid",
        safeValidationMessage(error, "Action preparation context is invalid."),
        false,
      );
    }

    const before = observeInterruption(context.interruption);
    if (before !== null) return before;

    let adapterResult: ActionAdapterPreparationResult;
    try {
      adapterResult = await adapter.prepare(
        Object.freeze({ actionName: action.name, input: input.action.input }),
        context,
      );
    } catch {
      const afterFailure = observeInterruption(context.interruption);
      if (afterFailure !== null) return afterFailure;
      return failed(
        "tool_action_adapter_failed",
        "The Action adapter failed during preparation.",
        false,
      );
    }

    const after = observeInterruption(context.interruption);
    if (after !== null) return after;

    try {
      assertAdapterResult(adapterResult);
      if (adapterResult.status === "rejected") {
        return rejected(
          adapterResult.code,
          validateBoundedText(
            adapterResult.message,
            "adapterResult.message",
            "canonical_contract_invalid",
          ),
        );
      }
      if (adapterResult.status === "failed") {
        return failed(
          validateToolFailureCode(adapterResult.code),
          validateBoundedText(
            adapterResult.message,
            "adapterResult.message",
            "canonical_contract_invalid",
          ),
          assertBoolean(adapterResult.retryable, "adapterResult.retryable"),
        );
      }
      if (adapterResult.status === "interrupted") {
        return interrupted(snapshotInterruption(adapterResult.interruption));
      }

      const data = adapterResult.data;
      assertPreparedData(data);
      const operation = createCanonicalActionOperation(data.operation);
      const effectSet = createActionEffectSet(data.effectSet);
      const preparedInvocation = createPreparedActionInvocation(data.preparedInvocation);
      assertPreparedInvocationMatchesExecutor(preparedInvocation, registration.executor);
      const requestedPermissions = snapshotCanonicalAdditionalPermissions(
        data.requestedPermissions,
        context.environment,
      );
      const targetAssertions = createTargetStateAssertions([
        ...data.targetAssertions,
        {
          kind: "adapter_registration",
          expected: registration.adapter,
          registrationFingerprint: registration.registrationFingerprint,
        },
        {
          kind: "executor_registration",
          expected: registration.executor,
          registrationFingerprint: registration.registrationFingerprint,
        },
        {
          kind: "environment_identity",
          expected: context.environment,
        },
      ]);
      const approvalCategory = validateApprovalCategory(data.approvalCategory);
      if ((approvalCategory === null) !== (data.approvalPayload === null)) {
        throw contractError(
          "canonical_contract_invalid",
          "Approval category and category-specific payload must either both be present or both be null.",
          "adapterResult.data.approvalPayload",
        );
      }
      const approvalPayload = approvalCategory === null
        ? null
        : snapshotApprovalPayload(approvalCategory, data.approvalPayload!);
      const applicabilityKeys = createApprovalApplicabilityKeys(
        approvalCategory,
        data.applicabilityKeys,
      );
      const safeSummary = createSafeActionSummary(data.safeSummary);
      assertCanonicalActionCoherence({ operation, effectSet, targetAssertions });
      let preparedInvocationDigest: string;
      try {
        preparedInvocationDigest = await createPreparedInvocationDigest(preparedInvocation);
      } catch {
        return failed(
          "tool_action_fingerprint_failed",
          "Prepared Action invocation fingerprint calculation failed.",
          false,
        );
      }
      const subject = createCanonicalActionSubject({
        action,
        registration,
        workspace: context.workspace,
        actor: context.actor,
        environment: context.environment,
        operation,
        effectSet,
        requestedPermissions,
        approvalCategory,
        applicabilityKeys,
        preparedInvocationDigest,
        targetAssertions,
      });
      let actionFingerprint: string;
      try {
        actionFingerprint = await createActionFingerprint(subject);
      } catch {
        return failed(
          "tool_action_fingerprint_failed",
          "Action fingerprint calculation failed.",
          false,
        );
      }
      let preparedAt: ISODateTimeString;
      try {
        preparedAt = validatePreparedAt(this.now());
      } catch {
        return failed(
          "tool_action_preparation_clock_invalid",
          "Action preparation clock returned an invalid timestamp.",
          false,
        );
      }

      return Object.freeze({
        status: "prepared" as const,
        prepared: createPreparedExternalAction({
          action,
          subject,
          actionFingerprint,
          safeSummary,
          approvalPayload,
          preparedInvocation,
          preparedAt,
        }),
      });
    } catch (error) {
      const interruption = observeInterruption(context.interruption);
      if (interruption !== null) return interruption;
      return failed(
        "tool_action_adapter_contract_invalid",
        safeValidationMessage(error, "The Action adapter returned invalid preparation data."),
        false,
      );
    }
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
      "runtime",
      "runtime_action_assessment_interruption_unattributed",
      "Action assessment was aborted without interruption attribution.",
    );
  }
  try {
    return Object.freeze({ status: "interrupted" as const, interruption: snapshotInterruption(context.interruption) });
  } catch {
    return assessmentFailed(
      "runtime",
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
  owner: RuntimeError["owner"],
  code: string,
  message: string,
): ActionAssessment {
  return Object.freeze({
    status: "failed" as const,
    error: Object.freeze({ owner, code, message, retryable: false, metadata: Object.freeze({}) }),
  });
}

function assertAdapterResult(input: ActionAdapterPreparationResult): void {
  if (input?.status === "prepared") {
    assertStrictRecord(input, "adapterResult", new Set(["status", "data"]), "canonical_contract_invalid");
    return;
  }
  if (input?.status === "rejected") {
    assertStrictRecord(
      input,
      "adapterResult",
      new Set(["status", "code", "message"]),
      "canonical_contract_invalid",
    );
    if (input.code !== "action_invalid" && input.code !== "action_unsupported") {
      throw contractError(
        "canonical_contract_invalid",
        "Unknown adapter rejection code.",
        "adapterResult.code",
      );
    }
    return;
  }
  if (input?.status === "failed") {
    assertStrictRecord(
      input,
      "adapterResult",
      new Set(["status", "code", "message", "retryable"]),
      "canonical_contract_invalid",
    );
    return;
  }
  if (input?.status === "interrupted") {
    assertStrictRecord(
      input,
      "adapterResult",
      new Set(["status", "interruption"]),
      "canonical_contract_invalid",
    );
    return;
  }
  throw contractError(
    "canonical_contract_invalid",
    "Unknown Action adapter preparation result.",
    "adapterResult.status",
  );
}

function assertPreparedData(
  input: Extract<ActionAdapterPreparationResult, { readonly status: "prepared" }>["data"],
): void {
  assertStrictRecord(
    input,
    "adapterResult.data",
    new Set([
      "operation",
      "effectSet",
      "requestedPermissions",
      "targetAssertions",
      "approvalCategory",
      "approvalPayload",
      "applicabilityKeys",
      "safeSummary",
      "preparedInvocation",
    ]),
    "canonical_contract_invalid",
  );
}

function assertInterruptionContext(input: InvocationInterruptionContext): void {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.signal?.aborted !== "boolean" ||
    typeof input.signal?.addEventListener !== "function"
  ) {
    throw new TypeError("Action preparation requires an interruption context.");
  }
}

function observeInterruption(
  context: InvocationInterruptionContext,
): ActionPreparationResult | null {
  if (!context.signal.aborted) return null;
  if (context.interruption === null) {
    return failed(
      "tool_action_interruption_unattributed",
      "Action preparation was aborted without interruption attribution.",
      false,
    );
  }
  try {
    return interrupted(snapshotInterruption(context.interruption));
  } catch (error) {
    return failed(
      "tool_action_interruption_invalid",
      safeValidationMessage(error, "Action preparation interruption attribution is invalid."),
      false,
    );
  }
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

function rejected(code: ActionRejectedCode, message: string): ActionPreparationResult {
  return Object.freeze({ status: "rejected", code, message });
}

function failed(code: string, message: string, retryable: boolean): ActionPreparationResult {
  return Object.freeze({
    status: "failed",
    error: Object.freeze({
      owner: "tool" as const,
      code,
      message,
      retryable,
      metadata: Object.freeze({}),
    }),
  });
}

function interrupted(interruption: InvocationInterruptionRef): ActionPreparationResult {
  return Object.freeze({ status: "interrupted", interruption });
}

function safeValidationMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 8_192) {
    return error.message;
  }
  return fallback;
}

function hasDataProperty(input: unknown, key: PropertyKey): input is Record<PropertyKey, unknown> {
  if (input === null || typeof input !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined;
}
