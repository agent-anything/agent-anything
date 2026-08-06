import type { InvocationInterruptionRef } from "@agent-anything/agent-core/run";

import { createPreparedInvocationDigest } from "../canonical/ActionFingerprint.js";
import { createCanonicalSha256Digest } from "../canonical/CanonicalEncoding.js";
import { assertPreparedInvocationMatchesExecutor } from "../canonical/PreparedActionInvocation.js";
import { assertActionDispatchPlan } from "../enforcement/ActionRevalidation.js";
import type {
  ActionExecutionLimits,
  DispatchSandboxActionInput,
  SandboxAttempt,
  SandboxPolicyEnvelope,
} from "./SandboxContracts.js";

export type SandboxDispatchPreparationStageResult =
  | {
      readonly status: "ready";
      readonly attempt: SandboxAttempt;
      readonly policy: SandboxPolicyEnvelope;
      readonly invocation: DispatchSandboxActionInput["preparedInvocation"];
    }
  | {
      readonly status: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
    };

export async function prepareSandboxDispatch(input: {
  readonly dispatch: DispatchSandboxActionInput;
  readonly limits: ActionExecutionLimits;
  readonly now: () => string;
  readonly createAttemptId: (identity: {
    readonly runId: string;
    readonly actionId: string;
    readonly ordinal: 1 | 2;
  }) => string;
}): Promise<SandboxDispatchPreparationStageResult> {
  let invocation: DispatchSandboxActionInput["preparedInvocation"];
  try {
    invocation = await validateDispatchInput(input.dispatch);
  } catch (error) {
    return failed(
      "sandbox_dispatch_invalid",
      safeMessage(error, "Sandbox dispatch input is invalid."),
    );
  }

  const initialInterruption = observeInterruption(
    input.dispatch,
    input.dispatch.plan.runId,
  );
  if (initialInterruption.status === "invalid") {
    return failed(
      "sandbox_interruption_unattributed",
      initialInterruption.message,
    );
  }
  if (initialInterruption.status === "interrupted") {
    return initialInterruption;
  }

  const startedAt = input.now();
  if (!isCanonicalDateTime(startedAt)) {
    return failed(
      "sandbox_clock_invalid",
      "Sandbox clock returned an invalid timestamp.",
    );
  }
  const policy = await createSandboxPolicy(
    input.dispatch.plan,
    input.limits,
  );
  const attemptId = input.createAttemptId({
    runId: input.dispatch.plan.runId,
    actionId: input.dispatch.plan.actionId,
    ordinal: input.dispatch.plan.attemptOrdinal,
  });
  if (!isCanonicalToken(attemptId)) {
    return failed(
      "sandbox_attempt_id_invalid",
      "Sandbox attempt id is invalid.",
    );
  }
  const attempt: SandboxAttempt = deepFreeze({
    id: attemptId,
    runId: input.dispatch.plan.runId,
    actionId: input.dispatch.plan.actionId,
    actionFingerprint: input.dispatch.plan.actionFingerprint,
    ordinal: input.dispatch.plan.attemptOrdinal,
    enforcement: input.dispatch.plan.enforcement,
    policyId: policy.policyId,
    authoritySnapshotId: input.dispatch.plan.authoritySnapshotId,
    dispatchPlanFingerprint: input.dispatch.plan.dispatchPlanFingerprint,
    startedAt,
  });
  if (Date.parse(input.dispatch.deadlineAt) <= Date.parse(startedAt)) {
    return Object.freeze({
      status: "interrupted" as const,
      interruption: Object.freeze({
        kind: "operation_deadline" as const,
        deadline: Object.freeze({
          operationId: attempt.id,
          deadlineAt: input.dispatch.deadlineAt,
        }),
      }),
    });
  }

  return Object.freeze({
    status: "ready" as const,
    attempt,
    policy,
    invocation,
  });
}

async function validateDispatchInput(
  input: DispatchSandboxActionInput,
): Promise<DispatchSandboxActionInput["preparedInvocation"]> {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Sandbox dispatch input must be an object.");
  }
  assertActionDispatchPlan(input.plan);
  if (!isCanonicalDateTime(input.deadlineAt)) {
    throw new TypeError("Sandbox deadlineAt must be a canonical timestamp.");
  }
  assertPreparedInvocationMatchesExecutor(
    input.preparedInvocation,
    input.plan.registration.executor,
  );
  const digest = await createPreparedInvocationDigest(
    input.preparedInvocation,
  );
  if (digest !== input.plan.preparedInvocationDigest) {
    throw new TypeError(
      "Prepared invocation digest does not match the dispatch plan.",
    );
  }
  if (
    !sameStrings(
      input.preparedInvocation.secretReferences,
      input.plan.allowedSecretReferences,
    )
  ) {
    throw new TypeError(
      "Prepared invocation secret references do not match the dispatch plan.",
    );
  }
  return input.preparedInvocation;
}

async function createSandboxPolicy(
  plan: DispatchSandboxActionInput["plan"],
  limits: ActionExecutionLimits,
): Promise<SandboxPolicyEnvelope> {
  const fields = {
    schemaVersion: 1 as const,
    actionFingerprint: plan.actionFingerprint,
    authoritySnapshotId: plan.authoritySnapshotId,
    enforcement: plan.enforcement,
    defaultDisposition: "deny" as const,
    authorizedEffects: plan.authorizedEffects,
    fileSystemPermissions: plan.effectivePermissions.fileSystem,
    processPermissions: plan.effectivePermissions.process,
    networkPermissions: plan.effectivePermissions.network,
    remoteToolPermissions: plan.effectivePermissions.remoteTool,
    environmentPolicy: Object.freeze({
      kind: "bound_configuration" as const,
      environment: plan.environment,
    }),
    resourceLimits: limits,
    allowedSecretReferences: plan.allowedSecretReferences,
  };
  const policyId = await createCanonicalSha256Digest(
    "agent-anything.sandbox-policy.v1",
    fields,
  );
  return deepFreeze({ ...fields, policyId });
}

function observeInterruption(
  input: DispatchSandboxActionInput,
  runId: string,
):
  | { readonly status: "active" }
  | {
      readonly status: "interrupted";
      readonly interruption: InvocationInterruptionRef;
    }
  | { readonly status: "invalid"; readonly message: string } {
  const context = input.interruption;
  if (!context?.signal || typeof context.signal.aborted !== "boolean") {
    return {
      status: "invalid",
      message: "Sandbox interruption context is invalid.",
    };
  }
  if (!context.signal.aborted) return { status: "active" };
  try {
    const candidate = context.interruption ??
      interruptionFromReason(context.signal.reason, runId);
    if (candidate === null) {
      throw new TypeError("Missing interruption attribution.");
    }
    return {
      status: "interrupted",
      interruption: snapshotInterruption(candidate, runId),
    };
  } catch (error) {
    return {
      status: "invalid",
      message: safeMessage(error, "Interruption is unattributed."),
    };
  }
}

function interruptionFromReason(
  reason: unknown,
  runId: string,
): InvocationInterruptionRef | null {
  if (
    reason !== null &&
    typeof reason === "object" &&
    "id" in reason &&
    "runId" in reason &&
    typeof reason.id === "string" &&
    reason.runId === runId
  ) {
    return Object.freeze({
      kind: "run_cancellation" as const,
      cancellation: Object.freeze({ runId, requestId: reason.id }),
    });
  }
  return null;
}

function snapshotInterruption(
  interruption: InvocationInterruptionRef,
  runId: string,
): InvocationInterruptionRef {
  if (
    interruption?.kind === "run_cancellation" &&
    interruption.cancellation?.runId === runId &&
    isCanonicalToken(interruption.cancellation.requestId)
  ) {
    return deepFreeze({ ...interruption });
  }
  if (
    interruption?.kind === "operation_deadline" &&
    isCanonicalToken(interruption.deadline?.operationId) &&
    isCanonicalDateTime(interruption.deadline?.deadlineAt)
  ) {
    return deepFreeze({ ...interruption });
  }
  throw new TypeError("Sandbox interruption attribution is invalid.");
}

function failed(
  code: string,
  message: string,
): SandboxDispatchPreparationStageResult {
  return Object.freeze({ status: "failed" as const, code, message });
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isCanonicalDateTime(input: unknown): input is string {
  return typeof input === "string" &&
    !Number.isNaN(Date.parse(input)) &&
    new Date(input).toISOString() === input;
}

function isCanonicalToken(input: unknown): input is string {
  return typeof input === "string" &&
    input.length > 0 &&
    input.length <= 1_024 &&
    input === input.trim() &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input);
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    typeof value !== "object" ||
    value === null ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
