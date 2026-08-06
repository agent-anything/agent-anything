import type { Action, ActionRejectedCode } from "@agent-anything/agent-core/action";
import type {
  InvocationInterruptionContext,
  InvocationInterruptionRef,
} from "@agent-anything/agent-core/run";
import { snapshotApprovalPayload } from "@agent-anything/permission/approval";

import {
  assertCanonicalActionCoherence,
} from "../canonical/CanonicalActionCoherence.js";
import { createCanonicalActionOperation } from "../canonical/CanonicalActionOperation.js";
import {
  assertStrictRecord,
  contractError,
  validateBoundedText,
  validateToken,
} from "../canonical/ActionContractValidation.js";
import {
  createActionFingerprint,
  createPreparedInvocationDigest,
} from "../canonical/ActionFingerprint.js";
import type {
  CanonicalActorIdentity,
  CanonicalEnvironmentIdentityInput,
  CanonicalWorkspaceIdentityInput,
} from "../canonical/CanonicalIdentity.js";
import { createActionEffectSet } from "../canonical/CapabilityEffect.js";
import {
  assertPreparedInvocationMatchesExecutor,
  createPreparedActionInvocation,
} from "../canonical/PreparedActionInvocation.js";
import { createSafeActionSummary } from "../canonical/SafeActionSummary.js";
import { createTargetStateAssertions } from "../canonical/TargetStateAssertion.js";
import {
  createActionExecutionFailure,
  type ActionExecutionFailure,
} from "../execution/ActionExecutionFailure.js";
import type {
  ActionAdapterImplementationSnapshot,
  ActionAdapterPreparationResult,
} from "../registration/ActionAdapter.js";
import type { ActionRegistrationSnapshot } from "../registration/ActionRegistration.js";
import type { ToolActionBindingSnapshot } from "../registration/ToolActionBinding.js";
import {
  createActionPreparationContext,
  resolveActionPreparation,
} from "./ActionPreparationResolution.js";
import {
  createApprovalApplicabilityKeys,
  createCanonicalActionSubject,
  createPreparedExternalAction,
  snapshotCanonicalAdditionalPermissions,
  type PreparedExternalAction,
  validateApprovalCategory,
  validatePreparedAt,
} from "./PreparedExternalAction.js";

export interface PrepareExternalActionInput {
  readonly action: Action;
  readonly workspace: CanonicalWorkspaceIdentityInput;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentityInput;
  readonly interruption: InvocationInterruptionContext;
}

export type ActionPreparationResult =
  | { readonly status: "prepared"; readonly prepared: PreparedExternalAction }
  | {
      readonly status: "rejected";
      readonly code: ActionRejectedCode;
      readonly message: string;
    }
  | { readonly status: "failed"; readonly failure: ActionExecutionFailure }
  | {
      readonly status: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    };

export interface ActionPreparationCoordinatorDependencies {
  readonly registrations: ActionRegistrationSnapshot;
  readonly toolBindings: ToolActionBindingSnapshot;
  readonly adapters: ActionAdapterImplementationSnapshot;
  readonly now: () => string;
}

export class ActionPreparationCoordinator {
  constructor(
    private readonly dependencies: ActionPreparationCoordinatorDependencies,
  ) {}

  async prepare(
    input: PrepareExternalActionInput,
  ): Promise<ActionPreparationResult> {
    const resolution = resolveActionPreparation(
      input.action,
      this.dependencies.registrations,
      this.dependencies.toolBindings,
      this.dependencies.adapters,
    );
    if (resolution.status === "rejected") {
      return rejected(resolution.code, resolution.message);
    }
    if (resolution.status === "failed") {
      return failed(
        resolution.code,
        resolution.message,
        resolution.retryable,
      );
    }
    const { action, registration, adapter } = resolution;

    let context;
    try {
      context = createActionPreparationContext(input);
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
        Object.freeze({
          actionName: action.boundActionName,
          input: input.action.input,
        }),
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
      const preparedInvocation = createPreparedActionInvocation(
        data.preparedInvocation,
      );
      assertPreparedInvocationMatchesExecutor(
        preparedInvocation,
        registration.executor,
      );
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
      if (
        (approvalCategory === null) !== (data.approvalPayload === null)
      ) {
        throw contractError(
          "canonical_contract_invalid",
          "Approval category and category-specific payload must either both be present or both be null.",
          "adapterResult.data.approvalPayload",
        );
      }
      const approvalPayload = approvalCategory === null
        ? null
        : snapshotApprovalPayload(
          approvalCategory,
          data.approvalPayload!,
        );
      const applicabilityKeys = createApprovalApplicabilityKeys(
        approvalCategory,
        data.applicabilityKeys,
      );
      const safeSummary = createSafeActionSummary(data.safeSummary);
      assertCanonicalActionCoherence({
        operation,
        effectSet,
        targetAssertions,
      });
      let preparedInvocationDigest: string;
      try {
        preparedInvocationDigest = await createPreparedInvocationDigest(
          preparedInvocation,
        );
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
      let preparedAt: string;
      try {
        preparedAt = validatePreparedAt(this.dependencies.now());
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
        safeValidationMessage(
          error,
          "The Action adapter returned invalid preparation data.",
        ),
        false,
      );
    }
  }
}

function assertAdapterResult(input: ActionAdapterPreparationResult): void {
  if (input?.status === "prepared") {
    assertStrictRecord(
      input,
      "adapterResult",
      new Set(["status", "data"]),
      "canonical_contract_invalid",
    );
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
  input: Extract<
    ActionAdapterPreparationResult,
    { readonly status: "prepared" }
  >["data"],
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
      safeValidationMessage(
        error,
        "Action preparation interruption attribution is invalid.",
      ),
      false,
    );
  }
}

function snapshotInterruption(
  input: InvocationInterruptionRef,
): InvocationInterruptionRef {
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
        runId: validateToken(
          input.cancellation.runId,
          "interruption.cancellation.runId",
        ),
        requestId: validateToken(
          input.cancellation.requestId,
          "interruption.cancellation.requestId",
        ),
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
        operationId: validateToken(
          input.deadline.operationId,
          "interruption.deadline.operationId",
        ),
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
    throw contractError(
      "canonical_contract_invalid",
      `A boolean is required at ${path}.`,
      path,
    );
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

function rejected(
  code: ActionRejectedCode,
  message: string,
): ActionPreparationResult {
  return Object.freeze({ status: "rejected", code, message });
}

function failed(
  code: string,
  message: string,
  retryable: boolean,
): ActionPreparationResult {
  return Object.freeze({
    status: "failed",
    failure: createActionExecutionFailure("tool", Object.freeze({
      code,
      message,
      retryable,
      metadata: Object.freeze({}),
    })),
  });
}

function interrupted(
  interruption: InvocationInterruptionRef,
): ActionPreparationResult {
  return Object.freeze({ status: "interrupted", interruption });
}

function safeValidationMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    error.message.length > 0 &&
    error.message.length <= 8_192
  ) {
    return error.message;
  }
  return fallback;
}
