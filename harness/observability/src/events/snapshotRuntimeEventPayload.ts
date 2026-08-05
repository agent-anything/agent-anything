
import type {
  RuntimeEventName,
  RuntimeEventPayloadMap,
  RuntimePlanProjection,
} from "./RuntimeEventPayload.js";

type AnyRuntimeEventPayload = RuntimeEventPayloadMap[RuntimeEventName];
type RecordValue = Readonly<Record<string, unknown>>;

export function snapshotRuntimeEventPayload<TName extends RuntimeEventName>(
  name: TName,
  candidate: RuntimeEventPayloadMap[TName],
): RuntimeEventPayloadMap[TName] {
  const source = record(candidate, `RuntimeEvent '${name}' payload`);
  return snapshotPayload(name, source) as RuntimeEventPayloadMap[TName];
}

function snapshotPayload(
  name: RuntimeEventName,
  source: RecordValue,
): AnyRuntimeEventPayload {
  switch (name) {
    case "run.started":
      return Object.freeze({
        status: literal(source.status, ["running"], "status"),
        activeAgentId: text(source.activeAgentId, "activeAgentId"),
      });
    case "run.item.appended":
      return Object.freeze({
        itemId: text(source.itemId, "itemId"),
        itemKind: literal(source.itemKind, runItemKinds, "itemKind"),
        itemSequence: positiveInteger(source.itemSequence, "itemSequence"),
      });
    case "run.completed":
      return terminalPayload(source, "succeeded");
    case "run.blocked":
      return terminalPayload(source, "blocked");
    case "run.failed":
      return terminalPayload(source, "failed");
    case "run.cancelled":
      return terminalPayload(source, "cancelled");
    case "controller.started":
      return Object.freeze({
        iteration: positiveInteger(source.iteration, "iteration"),
      });
    case "controller.finished":
      return Object.freeze({
        iteration: positiveInteger(source.iteration, "iteration"),
        status: literal(
          source.status,
          ["succeeded", "failed", "cancelled"],
          "status",
        ),
        code: nullableText(source.code, "code"),
        decisionKind: nullableLiteral(
          source.decisionKind,
          ["final_output", "actions", "stop"],
          "decisionKind",
        ),
      });
    case "plan.created":
    case "plan.completed":
      return Object.freeze({ plan: plan(source.plan) });
    case "plan.updated":
      return Object.freeze({
        plan: plan(source.plan),
        previousVersion: positiveInteger(source.previousVersion, "previousVersion"),
        transition: literal(source.transition, ["updated", "reactivated"], "transition"),
      });
    case "plan.abandoned":
      return Object.freeze({
        plan: plan(source.plan),
        terminalStatus: literal(
          source.terminalStatus,
          ["succeeded", "blocked", "failed", "cancelled"],
          "terminalStatus",
        ),
        reasonCode: nullableText(source.reasonCode, "reasonCode"),
      });
    case "action.prepared":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        actionFingerprint: text(source.actionFingerprint, "actionFingerprint"),
        category: literal(
          source.category,
          ["file_system", "process", "network", "remote_tool", "computation"],
          "category",
        ),
        effectCount: nonNegativeInteger(source.effectCount, "effectCount"),
        targetAssertionCount: nonNegativeInteger(
          source.targetAssertionCount,
          "targetAssertionCount",
        ),
      });
    case "action.assessed":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        actionFingerprint: text(source.actionFingerprint, "actionFingerprint"),
        status: literal(
          source.status,
          [
            "authorized",
            "approval_required",
            "denied",
            "invalidated",
            "failed",
            "interrupted",
          ],
          "status",
        ),
        owner: nullableLiteral(source.owner, ["policy", "permission", "tool"], "owner"),
        code: nullableText(source.code, "code"),
      });
    case "action.invalidated":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        actionFingerprint: text(source.actionFingerprint, "actionFingerprint"),
        phase: literal(
          source.phase,
          ["assessment", "revalidation", "dispatch"],
          "phase",
        ),
        owner: literal(source.owner, ["permission", "tool"], "owner"),
        code: text(source.code, "code"),
      });
    case "approval.requested":
      return Object.freeze({
        requestId: text(source.requestId, "requestId"),
        actionId: text(source.actionId, "actionId"),
        actionFingerprint: text(source.actionFingerprint, "actionFingerprint"),
        category: literal(
          source.category,
          approvalCategories,
          "category",
        ),
        pendingVersion: positiveInteger(source.pendingVersion, "pendingVersion"),
        reviewer: literal(source.reviewer, ["user", "auto_review"], "reviewer"),
        phase: literal(source.phase, ["reviewing"], "phase"),
        reviewOperationId: text(source.reviewOperationId, "reviewOperationId"),
      });
    case "approval.resolved":
      return Object.freeze({
        requestId: text(source.requestId, "requestId"),
        actionId: text(source.actionId, "actionId"),
        actionFingerprint: text(source.actionFingerprint, "actionFingerprint"),
        pendingVersion: positiveInteger(source.pendingVersion, "pendingVersion"),
        reviewer: literal(source.reviewer, ["user", "auto_review"], "reviewer"),
        resolutionKind: literal(
          source.resolutionKind,
          ["decision", "review_failure", "request_failure", "run_cancelled"],
          "resolutionKind",
        ),
        decisionKind: nullableLiteral(
          source.decisionKind,
          approvalDecisionKinds,
          "decisionKind",
        ),
        applicationKind: literal(
          source.applicationKind,
          [
            "not_applicable",
            "applied",
            "not_applied",
            "interrupted",
            "outcome_unknown",
          ],
          "applicationKind",
        ),
        code: nullableText(source.code, "code"),
        authorityRecordIds: textArray(source.authorityRecordIds, "authorityRecordIds"),
      });
    case "sandbox.attempt.started":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        attemptId: text(source.attemptId, "attemptId"),
        ordinal: literal(source.ordinal, [1, 2], "ordinal"),
        enforcement: literal(
          source.enforcement,
          ["managed", "external", "disabled"],
          "enforcement",
        ),
      });
    case "sandbox.attempt.resolved":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        attemptId: text(source.attemptId, "attemptId"),
        ordinal: literal(source.ordinal, [1, 2], "ordinal"),
        enforcement: literal(
          source.enforcement,
          ["managed", "external", "disabled"],
          "enforcement",
        ),
        outcome: literal(
          source.outcome,
          [
            "executed",
            "sandbox_denied",
            "sandbox_unavailable",
            "interrupted",
            "failed",
          ],
          "outcome",
        ),
        code: nullableText(source.code, "code"),
      });
    case "sandbox.escalation.proposed":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        previousAttemptId: text(source.previousAttemptId, "previousAttemptId"),
        previousActionFingerprint: text(
          source.previousActionFingerprint,
          "previousActionFingerprint",
        ),
        nextActionFingerprint: text(
          source.nextActionFingerprint,
          "nextActionFingerprint",
        ),
        deniedEffectKind: literal(
          source.deniedEffectKind,
          ["file_system", "network"],
          "deniedEffectKind",
        ),
      });
    case "tool.started":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        toolName: text(source.toolName, "toolName"),
      });
    case "tool.finished":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        toolName: text(source.toolName, "toolName"),
        status: literal(source.status, ["succeeded", "failed"], "status"),
        code: nullableText(source.code, "code"),
        toolResultStatus: literal(
          source.toolResultStatus,
          ["succeeded", "partial", "failed", "timeout"],
          "toolResultStatus",
        ),
        durationMs: nonNegativeInteger(source.durationMs, "durationMs"),
      });
    case "observation.created":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        observationId: text(source.observationId, "observationId"),
        status: literal(
          source.status,
          observationStatuses,
          "status",
        ),
        code: nullableText(source.code, "code"),
      });
    case "context.updated":
      return Object.freeze({
        observationId: text(source.observationId, "observationId"),
      });
    case "evidence.created":
      return Object.freeze({
        actionId: text(source.actionId, "actionId"),
        evidenceId: text(source.evidenceId, "evidenceId"),
      });
    case "retry.attempt.started":
      return Object.freeze({
        ...retryBase(source),
        attemptId: text(source.attemptId, "attemptId"),
        budgetId: text(source.budgetId, "budgetId"),
        attemptNumber: positiveInteger(source.attemptNumber, "attemptNumber"),
        budgetAttemptNumber: positiveInteger(
          source.budgetAttemptNumber,
          "budgetAttemptNumber",
        ),
        maxBudgetAttempts: positiveInteger(
          source.maxBudgetAttempts,
          "maxBudgetAttempts",
        ),
      });
    case "retry.attempt.finished":
      return Object.freeze({
        ...retryBase(source),
        attemptId: text(source.attemptId, "attemptId"),
        budgetId: text(source.budgetId, "budgetId"),
        attemptNumber: positiveInteger(source.attemptNumber, "attemptNumber"),
        budgetAttemptNumber: positiveInteger(
          source.budgetAttemptNumber,
          "budgetAttemptNumber",
        ),
        durationMs: nonNegativeInteger(source.durationMs, "durationMs"),
        outcome: literal(
          source.outcome,
          ["succeeded", "failed", "cancelled"],
          "outcome",
        ),
        failureCategory: nullableText(source.failureCategory, "failureCategory"),
        failureCode: nullableText(source.failureCode, "failureCode"),
        next: literal(
          source.next,
          retryNextValues,
          "next",
        ),
      });
    case "retry.scheduled":
      return Object.freeze({
        ...retryBase(source),
        afterAttemptId: text(source.afterAttemptId, "afterAttemptId"),
        budgetId: text(source.budgetId, "budgetId"),
        retryNumber: positiveInteger(source.retryNumber, "retryNumber"),
        nextAttemptNumber: positiveInteger(
          source.nextAttemptNumber,
          "nextAttemptNumber",
        ),
        nextBudgetAttemptNumber: positiveInteger(
          source.nextBudgetAttemptNumber,
          "nextBudgetAttemptNumber",
        ),
        delayMs: nonNegativeInteger(source.delayMs, "delayMs"),
        delaySource: literal(
          source.delaySource,
          ["calculated_backoff", "trusted_server_delay"],
          "delaySource",
        ),
        nextAttemptAt: dateTime(source.nextAttemptAt, "nextAttemptAt"),
        failureCategory: text(source.failureCategory, "failureCategory"),
        failureCode: text(source.failureCode, "failureCode"),
      });
    case "retry.fallback.selected":
      return Object.freeze({
        ...retryBase(source),
        fromLegId: text(source.fromLegId, "fromLegId"),
        toLegId: text(source.toLegId, "toLegId"),
        fromBudgetId: text(source.fromBudgetId, "fromBudgetId"),
        toBudgetId: text(source.toBudgetId, "toBudgetId"),
        fromTransport: text(source.fromTransport, "fromTransport"),
        toTransport: text(source.toTransport, "toTransport"),
        fallbackNumber: positiveInteger(source.fallbackNumber, "fallbackNumber"),
        reasonCode: text(source.reasonCode, "reasonCode"),
        nextAttemptNumber: positiveInteger(
          source.nextAttemptNumber,
          "nextAttemptNumber",
        ),
      });
    case "retry.exhausted":
      return Object.freeze({
        ...retryBase(source),
        finalBudgetId: text(source.finalBudgetId, "finalBudgetId"),
        reason: literal(
          source.reason,
          ["retry_budget_exhausted", "deadline_exceeded"],
          "reason",
        ),
        totalAttempts: nonNegativeInteger(source.totalAttempts, "totalAttempts"),
        totalRetryDelayMs: nonNegativeInteger(
          source.totalRetryDelayMs,
          "totalRetryDelayMs",
        ),
        lastFailureCategory: nullableText(
          source.lastFailureCategory,
          "lastFailureCategory",
        ),
        lastFailureCode: nullableText(source.lastFailureCode, "lastFailureCode"),
      });
    case "retry.cancelled": {
      const attribution = record(source.attribution, "attribution");
      return Object.freeze({
        ...retryBase(source),
        phase: literal(
          source.phase,
          ["before_attempt", "attempt", "backoff"],
          "phase",
        ),
        budgetId: text(source.budgetId, "budgetId"),
        attemptId: nullableText(source.attemptId, "attemptId"),
        attemptNumber: nullablePositiveInteger(
          source.attemptNumber,
          "attemptNumber",
        ),
        attribution: Object.freeze({
          requestId: text(attribution.requestId, "attribution.requestId"),
          operation: literal(
            attribution.operation,
            cancellationOperations,
            "attribution.operation",
          ),
          observedAt: dateTime(
            attribution.observedAt,
            "attribution.observedAt",
          ),
        }),
      });
    }
  }
}

function terminalPayload<TStatus extends "succeeded" | "blocked" | "failed" | "cancelled">(
  source: RecordValue,
  status: TStatus,
): RuntimeEventPayloadMap[
  TStatus extends "succeeded"
    ? "run.completed"
    : TStatus extends "blocked"
      ? "run.blocked"
      : TStatus extends "failed"
        ? "run.failed"
        : "run.cancelled"
] {
  if (source.status !== status) {
    throw new TypeError(`RuntimeEvent payload status must be '${status}'.`);
  }
  const code = status === "succeeded"
    ? nullValue(source.code, "code")
    : text(source.code, "code");
  return Object.freeze({
    status,
    code,
    durationMs: nonNegativeInteger(source.durationMs, "durationMs"),
    itemCount: nonNegativeInteger(source.itemCount, "itemCount"),
    evidenceCount: nonNegativeInteger(source.evidenceCount, "evidenceCount"),
    artifactCount: nonNegativeInteger(source.artifactCount, "artifactCount"),
    errorCodes: textArray(source.errorCodes, "errorCodes"),
  }) as unknown as RuntimeEventPayloadMap[
    TStatus extends "succeeded"
      ? "run.completed"
      : TStatus extends "blocked"
        ? "run.blocked"
        : TStatus extends "failed"
          ? "run.failed"
          : "run.cancelled"
  ];
}

function plan(candidate: unknown): RuntimePlanProjection {
  const source = record(candidate, "plan");
  if (!Array.isArray(source.steps)) {
    throw new TypeError("RuntimeEvent plan.steps must be an array.");
  }
  return Object.freeze({
    id: text(source.id, "plan.id"),
    version: positiveInteger(source.version, "plan.version"),
    status: literal(
      source.status,
      ["active", "completed", "abandoned"],
      "plan.status",
    ),
    steps: Object.freeze(source.steps.map((candidate, index) => {
      const step = record(candidate, `plan.steps[${index}]`);
      return Object.freeze({
        step: text(step.step, `plan.steps[${index}].step`),
        status: literal(
          step.status,
          ["pending", "in_progress", "completed"],
          `plan.steps[${index}].status`,
        ),
      });
    })),
  });
}

function retryBase(source: RecordValue): {
  readonly operationId: string;
  readonly owner:
    | "provider_request"
    | "response_stream"
    | "approvals_reviewer"
    | "structured_output";
} {
  return {
    operationId: text(source.operationId, "operationId"),
    owner: literal(source.owner, retryOwners, "owner"),
  };
}

function record(candidate: unknown, field: string): RecordValue {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`${field} must be an object.`);
  }
  return candidate as RecordValue;
}

function text(candidate: unknown, field: string): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new TypeError(`RuntimeEvent ${field} must be a non-empty string.`);
  }
  return candidate;
}

function nullableText(candidate: unknown, field: string): string | null {
  return candidate === null ? null : text(candidate, field);
}

function textArray(candidate: unknown, field: string): readonly string[] {
  if (!Array.isArray(candidate)) {
    throw new TypeError(`RuntimeEvent ${field} must be an array.`);
  }
  return Object.freeze(candidate.map((value, index) =>
    text(value, `${field}[${index}]`)
  ));
}

function positiveInteger(candidate: unknown, field: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
    throw new TypeError(`RuntimeEvent ${field} must be a positive safe integer.`);
  }
  return candidate as number;
}

function nullablePositiveInteger(candidate: unknown, field: string): number | null {
  return candidate === null ? null : positiveInteger(candidate, field);
}

function nonNegativeInteger(candidate: unknown, field: string): number {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new TypeError(
      `RuntimeEvent ${field} must be a non-negative safe integer.`,
    );
  }
  return candidate as number;
}

function dateTime(candidate: unknown, field: string): string {
  if (
    typeof candidate !== "string" ||
    candidate.trim().length === 0 ||
    !Number.isFinite(Date.parse(candidate))
  ) {
    throw new TypeError(`RuntimeEvent ${field} must be an ISO date-time string.`);
  }
  return candidate;
}

function nullValue(candidate: unknown, field: string): null {
  if (candidate !== null) {
    throw new TypeError(`RuntimeEvent ${field} must be null.`);
  }
  return null;
}

function literal<const TValue extends string | number>(
  candidate: unknown,
  allowed: readonly TValue[],
  field: string,
): TValue {
  if (!allowed.includes(candidate as TValue)) {
    throw new TypeError(`RuntimeEvent ${field} has an unsupported value.`);
  }
  return candidate as TValue;
}

function nullableLiteral<const TValue extends string>(
  candidate: unknown,
  allowed: readonly TValue[],
  field: string,
): TValue | null {
  return candidate === null ? null : literal(candidate, allowed, field);
}

const approvalCategories = Object.freeze([
  "commandExecution",
  "fileChange",
  "permissions",
  "remoteToolCall",
  "skill",
  "networkAccess",
] as const);

const approvalDecisionKinds = Object.freeze([
  "accept",
  "acceptForSession",
  "grantPermissions",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
] as const);

const observationStatuses = Object.freeze([
  "succeeded",
  "partial",
  "failed",
  "timeout",
  "denied",
  "rejected",
  "declined",
  "limit_reached",
  "granted",
  "updated",
] as const);

const retryOwners = Object.freeze([
  "provider_request",
  "response_stream",
  "approvals_reviewer",
  "structured_output",
] as const);

const retryNextValues = Object.freeze([
  "retry_scheduled",
  "budget_exhausted",
  "deadline_exhausted",
  "return_to_owner",
  "cancelled",
] as const);

const cancellationOperations = Object.freeze([
  "controller",
  "provider",
  "retry_wait",
  "approval_reviewer",
  "authority_commit",
  "tool",
  "process",
] as const);

const runItemKinds = Object.freeze([
  "model_output",
  "action",
  "observation",
  "plan_created",
  "plan_updated",
  "plan_completed",
  "plan_abandoned",
  "final_output",
  "stop",
  "run_cancellation_requested",
  "run_blocked",
  "run_failed",
  "run_cancelled",
  "approval_requested",
  "approval_resolved",
  "action_prepared",
  "action_assessed",
  "action_invalidated",
  "sandbox_attempt_started",
  "sandbox_attempt_resolved",
  "sandbox_escalation_proposed",
  "retry_attempt_started",
  "retry_attempt_finished",
  "retry_scheduled",
  "retry_fallback_selected",
  "retry_exhausted",
  "retry_cancelled",
] as const);
