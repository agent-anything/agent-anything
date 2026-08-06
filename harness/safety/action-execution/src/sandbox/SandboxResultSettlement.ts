import type { InvocationInterruptionRef } from "@agent-anything/agent-core/run";
import type { ToolResult } from "@agent-anything/tools";

import {
  createActionExecutionFailure,
} from "../execution/ActionExecutionFailure.js";
import type {
  ActionExecutorFailure,
  ActionExecutorResult,
} from "../execution/ActionExecutor.js";
import { snapshotCapabilityEffect } from "../canonical/CapabilityEffect.js";
import type {
  ActionExecutionResult,
  CapabilityEffectKind,
  SandboxAttempt,
  SandboxDenial,
  SandboxEnforcementEvidence,
  SandboxProviderDescriptor,
  SandboxProviderResult,
} from "./SandboxContracts.js";

const gatewaySandboxDenials = new WeakSet<object>();

export function assertGatewaySandboxDenial(denial: SandboxDenial): void {
  if (
    denial === null ||
    typeof denial !== "object" ||
    !gatewaySandboxDenials.has(denial) ||
    !Object.isFrozen(denial)
  ) {
    throw new TypeError("Sandbox escalation requires a gateway-validated denial.");
  }
}

export function settleExecutorResult(input: {
  readonly result: ActionExecutorResult;
  readonly attempt: SandboxAttempt;
  readonly boundActionName: string;
  readonly toolName: string;
  readonly maxResultBytes: number;
}): ActionExecutionResult {
  try {
    if (input.result?.status === "executed") {
      return Object.freeze({
        status: "executed" as const,
        attempt: input.attempt,
        toolResult: snapshotToolResult(
          input.result.toolResult,
          input.attempt,
          input.boundActionName,
          input.toolName,
          input.maxResultBytes,
        ),
        isolation: "unisolated" as const,
        enforcementEvidence: null,
      });
    }
    if (input.result?.status === "interrupted") {
      return Object.freeze({
        status: "interrupted" as const,
        attempt: input.attempt,
        interruption: snapshotExecutorInterruption(
          input.result.interruption,
          input.attempt.runId,
          input.attempt.id,
        ),
      });
    }
    if (input.result?.status === "failed") {
      const failure = snapshotExecutorFailure(input.result.failure);
      return Object.freeze({
        status: "failed" as const,
        attempt: input.attempt,
        effectState: failure.effectState,
        failure: createActionExecutionFailure("tool", Object.freeze({
          code: failure.code,
          message: failure.message,
          retryable: false,
          metadata: Object.freeze({ ...failure.metadata }),
        })),
      });
    }
    throw new ActionExecutorResultContractError(
      "ActionExecutor returned an unknown result.",
    );
  } catch (error) {
    return executionFailed(
      input.attempt,
      error instanceof ToolResultContractError
        ? "tool_result_invalid"
        : error instanceof ActionExecutorResultContractError
          ? "tool_executor_result_invalid"
          : "tool_executor_failed",
      safeMessage(error, "ActionExecutor failed without a settled result."),
      "unknown",
    );
  }
}

export function settleProviderResult(input: {
  readonly result: SandboxProviderResult;
  readonly attempt: SandboxAttempt;
  readonly boundActionName: string;
  readonly toolName: string;
  readonly descriptor: SandboxProviderDescriptor;
  readonly requiredKinds: readonly CapabilityEffectKind[];
  readonly maxResultBytes: number;
}): ActionExecutionResult {
  try {
    if (input.result?.status === "executed") {
      const evidence = snapshotEnforcementEvidence(
        input.result.enforcementEvidence,
        input.attempt,
        input.descriptor,
        input.requiredKinds,
      );
      return Object.freeze({
        status: "executed" as const,
        attempt: input.attempt,
        toolResult: snapshotToolResult(
          input.result.toolResult,
          input.attempt,
          input.boundActionName,
          input.toolName,
          input.maxResultBytes,
        ),
        isolation: "enforced" as const,
        enforcementEvidence: evidence,
      });
    }
    if (input.result?.status === "denied") {
      return Object.freeze({
        status: "sandbox_denied" as const,
        attempt: input.attempt,
        denial: snapshotDenial(input.result.denial, input.attempt),
      });
    }
    if (input.result?.status === "interrupted") {
      return Object.freeze({
        status: "interrupted" as const,
        attempt: input.attempt,
        interruption: snapshotInterruption(
          input.result.interruption,
          input.attempt.runId,
          input.attempt.id,
        ),
      });
    }
    if (input.result?.status === "enforcement_failed") {
      if (
        !["capability_check", "setup", "dispatch", "settlement"].includes(
          input.result.stage,
        ) ||
        !isCanonicalToken(input.result.code) ||
        (input.result.effectState !== "none" &&
          input.result.effectState !== "unknown")
      ) {
        throw new TypeError("Sandbox enforcement failure is invalid.");
      }
      return Object.freeze({
        status: "sandbox_unavailable" as const,
        attempt: input.attempt,
        code: input.result.code,
        stage: input.result.stage,
        effectState: input.result.effectState,
      });
    }
    throw new TypeError("SandboxProvider returned an unknown result.");
  } catch (error) {
    if (error instanceof ToolResultContractError) {
      return executionFailed(
        input.attempt,
        "tool_result_invalid",
        error.message,
        "unknown",
      );
    }
    return Object.freeze({
      status: "sandbox_unavailable" as const,
      attempt: input.attempt,
      code: "sandbox_provider_result_invalid",
      stage: "settlement" as const,
      effectState: "unknown" as const,
    });
  }
}

function snapshotEnforcementEvidence(
  evidence: SandboxEnforcementEvidence,
  attempt: SandboxAttempt,
  descriptor: SandboxProviderDescriptor,
  requiredKinds: readonly CapabilityEffectKind[],
): SandboxEnforcementEvidence {
  if (
    evidence?.providerId !== descriptor.id ||
    evidence.providerVersion !== descriptor.version ||
    evidence.policyId !== attempt.policyId ||
    evidence.enforcement !== descriptor.kind ||
    !isCanonicalDateTime(evidence.settledAt)
  ) {
    throw new TypeError(
      "Sandbox enforcement evidence correlation is invalid.",
    );
  }
  const kinds = snapshotEffectKinds(evidence.enforcedEffectKinds);
  if (requiredKinds.some((kind) => !kinds.includes(kind))) {
    throw new TypeError("Sandbox enforcement evidence is incomplete.");
  }
  return Object.freeze({ ...evidence, enforcedEffectKinds: kinds });
}

function snapshotDenial(
  denial: SandboxDenial,
  attempt: SandboxAttempt,
): SandboxDenial {
  if (
    denial?.attemptId !== attempt.id ||
    denial.runId !== attempt.runId ||
    denial.actionId !== attempt.actionId ||
    denial.actionFingerprint !== attempt.actionFingerprint ||
    denial.ordinal !== attempt.ordinal ||
    !isCanonicalToken(denial.code) ||
    (denial.effectState !== "none" && denial.effectState !== "unknown") ||
    typeof denial.message !== "string" ||
    denial.message.length === 0 ||
    denial.message.length > 2_000
  ) {
    throw new TypeError("SandboxDenial correlation is invalid.");
  }
  const snapshot = deepFreeze({
    ...denial,
    deniedEffect: snapshotCapabilityEffect(denial.deniedEffect),
  });
  gatewaySandboxDenials.add(snapshot);
  return snapshot;
}

function snapshotToolResult(
  result: ToolResult,
  attempt: SandboxAttempt,
  boundActionName: string,
  toolName: string,
  maxResultBytes: number,
): ToolResult {
  assertExactToolResultShape(result);
  if (
    result.toolCallId !== attempt.actionId ||
    result.toolName !== boundActionName ||
    !isCanonicalDateTime(result.startedAt) ||
    !isCanonicalDateTime(result.finishedAt) ||
    Date.parse(result.finishedAt) < Date.parse(result.startedAt) ||
    result.metadata === null ||
    typeof result.metadata !== "object" ||
    Array.isArray(result.metadata)
  ) {
    throw new ToolResultContractError(
      "ActionExecutor returned an invalid or uncorrelated ToolResult.",
    );
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(result);
  } catch {
    throw new ToolResultContractError(
      "ActionExecutor ToolResult is not serializable.",
    );
  }
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > maxResultBytes
  ) {
    throw new ToolResultContractError(
      "ActionExecutor ToolResult exceeds the configured result limit.",
    );
  }
  return deepFreeze({ ...result, toolName });
}

function assertExactToolResultShape(result: ToolResult): void {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getPrototypeOf(result) !== Object.prototype
  ) {
    throw new ToolResultContractError(
      "ActionExecutor ToolResult must be a plain object.",
    );
  }
  const common = [
    "toolCallId",
    "toolName",
    "status",
    "startedAt",
    "finishedAt",
    "metadata",
  ];
  switch (result.status) {
    case "succeeded":
      assertExactDataProperties(
        result,
        [...common, "output"],
        "Succeeded ToolResult",
      );
      if (result.output === null || result.output === undefined) {
        throw new ToolResultContractError(
          "Succeeded ToolResult requires output.",
        );
      }
      return;
    case "partial":
      assertExactDataProperties(
        result,
        [...common, "output", "outputUsability", "error"],
        "Partial ToolResult",
      );
      if (
        result.output === null ||
        result.output === undefined ||
        result.outputUsability !== "validated"
      ) {
        throw new ToolResultContractError(
          "Partial ToolResult requires validated usable output.",
        );
      }
      assertToolResultError(result.error);
      return;
    case "failed":
    case "timeout":
      assertExactDataProperties(
        result,
        [...common, "error"],
        "Failed ToolResult",
      );
      assertToolResultError(result.error);
      return;
    default:
      throw new ToolResultContractError(
        "ActionExecutor returned an unknown ToolResult status.",
      );
  }
}

function assertToolResultError(error: unknown): void {
  if (
    error === null ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    Object.getPrototypeOf(error) !== Object.prototype
  ) {
    throw new ToolResultContractError(
      "ToolResult error must be a plain object.",
    );
  }
  assertExactDataProperties(
    error,
    "metadata" in error
      ? ["code", "message", "metadata"]
      : ["code", "message"],
    "ToolResult error",
  );
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly metadata?: unknown;
  };
  if (
    !isCanonicalToken(candidate.code) ||
    typeof candidate.message !== "string" ||
    candidate.message.length === 0 ||
    candidate.message.length > 4_000 ||
    (candidate.metadata !== undefined &&
      (candidate.metadata === null ||
        typeof candidate.metadata !== "object" ||
        Array.isArray(candidate.metadata)))
  ) {
    throw new ToolResultContractError("ToolResult error is invalid.");
  }
}

function snapshotExecutorFailure(
  failure: ActionExecutorFailure,
): ActionExecutorFailure {
  if (
    failure === null ||
    typeof failure !== "object" ||
    Array.isArray(failure) ||
    Object.getPrototypeOf(failure) !== Object.prototype
  ) {
    throw new ActionExecutorResultContractError(
      "ActionExecutor failure must be a plain object.",
    );
  }
  assertExactExecutorResultDataProperties(
    failure,
    ["code", "message", "effectState", "metadata"],
    "ActionExecutor failure",
  );
  if (
    !isCanonicalToken(failure.code) ||
    typeof failure.message !== "string" ||
    failure.message.length === 0 ||
    failure.message.length > 4_000 ||
    (failure.effectState !== "none" && failure.effectState !== "unknown") ||
    failure.metadata === null ||
    typeof failure.metadata !== "object" ||
    Array.isArray(failure.metadata)
  ) {
    throw new ActionExecutorResultContractError(
      "ActionExecutor failure is invalid.",
    );
  }
  return deepFreeze({ ...failure, metadata: { ...failure.metadata } });
}

function snapshotExecutorInterruption(
  interruption: InvocationInterruptionRef,
  runId: string,
  expectedOperationId: string,
): InvocationInterruptionRef {
  try {
    return snapshotInterruption(interruption, runId, expectedOperationId);
  } catch (error) {
    throw new ActionExecutorResultContractError(
      safeMessage(error, "ActionExecutor interruption is invalid."),
    );
  }
}

function snapshotInterruption(
  input: InvocationInterruptionRef,
  runId: string,
  expectedOperationId: string,
): InvocationInterruptionRef {
  if (
    input?.kind === "run_cancellation" &&
    input.cancellation?.runId === runId &&
    isCanonicalToken(input.cancellation.requestId)
  ) {
    return deepFreeze({ ...input });
  }
  if (
    input?.kind === "operation_deadline" &&
    input.deadline?.operationId === expectedOperationId &&
    isCanonicalDateTime(input.deadline.deadlineAt)
  ) {
    return deepFreeze({ ...input });
  }
  throw new TypeError("Sandbox interruption attribution is invalid.");
}

function assertExactExecutorResultDataProperties(
  input: object,
  allowed: readonly string[],
  label: string,
): void {
  try {
    assertExactDataProperties(input, allowed, label);
  } catch (error) {
    throw new ActionExecutorResultContractError(
      safeMessage(error, `${label} fields are invalid.`),
    );
  }
}

function assertExactDataProperties(
  input: object,
  allowed: readonly string[],
  label: string,
): void {
  const expected = new Set(allowed);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expected.size) {
    throw new ToolResultContractError(`${label} fields are invalid.`);
  }
  for (const key of keys) {
    if (typeof key !== "string" || !expected.has(key)) {
      throw new ToolResultContractError(
        `${label} contains an unsupported field.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw new ToolResultContractError(
        `${label} contains an invalid property.`,
      );
    }
  }
}

function snapshotEffectKinds(
  input: readonly CapabilityEffectKind[],
): readonly CapabilityEffectKind[] {
  if (!Array.isArray(input)) {
    throw new TypeError("Effect kinds must be an array.");
  }
  const allowed = new Set<CapabilityEffectKind>([
    "file_system",
    "process",
    "network",
    "remote_tool",
  ]);
  const values = [...input];
  if (
    values.some((value) => !allowed.has(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new TypeError("Effect kinds are invalid or duplicated.");
  }
  return Object.freeze(values.sort());
}

function executionFailed(
  attempt: SandboxAttempt,
  code: string,
  message: string,
  effectState: "none" | "unknown",
): ActionExecutionResult {
  return Object.freeze({
    status: "failed" as const,
    attempt,
    effectState,
    failure: createActionExecutionFailure("tool", Object.freeze({
      code,
      message,
      retryable: false,
      metadata: Object.freeze({}),
    })),
  });
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

class ToolResultContractError extends TypeError {}
class ActionExecutorResultContractError extends TypeError {}
