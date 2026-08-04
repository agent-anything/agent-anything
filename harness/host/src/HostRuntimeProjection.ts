import type { Metadata } from "@agent-anything/foundation";
import type {
  RuntimeEvent,
  RuntimeEventName,
} from "@agent-anything/observability/events";

const lifecycleFields: Readonly<Record<RuntimeEventName, readonly string[]>> = {
  "run.started": ["status"],
  "run.item.appended": ["itemId", "itemKind", "itemSequence"],
  "run.completed": terminalFields(),
  "run.blocked": terminalFields(),
  "run.failed": terminalFields(),
  "run.cancelled": terminalFields(),
  "controller.started": ["iteration"],
  "controller.finished": [
    "iteration",
    "status",
    "code",
    "decisionKind",
  ],
  "plan.created": ["plan"],
  "plan.updated": ["plan", "previousVersion", "transition"],
  "plan.completed": ["plan"],
  "plan.abandoned": ["plan", "terminalStatus", "reasonCode"],
  "action.prepared": [
    "actionId",
    "actionFingerprint",
    "category",
    "effectCount",
    "targetAssertionCount",
  ],
  "action.assessed": [
    "actionId",
    "actionFingerprint",
    "status",
    "owner",
    "code",
  ],
  "action.invalidated": [
    "actionId",
    "actionFingerprint",
    "phase",
    "owner",
    "code",
  ],
  "approval.requested": [
    "requestId",
    "actionId",
    "pendingVersion",
    "category",
    "reviewer",
    "phase",
    "reviewOperationId",
  ],
  "approval.resolved": [
    "requestId",
    "actionId",
    "pendingVersion",
    "reviewer",
    "resolutionKind",
    "decisionKind",
    "applicationKind",
    "code",
    "authorityRecordIds",
  ],
  "sandbox.attempt.started": [
    "actionId",
    "attemptId",
    "ordinal",
    "enforcement",
  ],
  "sandbox.attempt.resolved": [
    "actionId",
    "attemptId",
    "ordinal",
    "enforcement",
    "outcome",
    "code",
  ],
  "sandbox.escalation.proposed": [
    "actionId",
    "previousAttemptId",
    "previousActionFingerprint",
    "nextActionFingerprint",
    "deniedEffectKind",
  ],
  "tool.started": ["actionId", "toolName"],
  "tool.finished": [
    "actionId",
    "toolName",
    "status",
    "code",
    "toolResultStatus",
    "durationMs",
  ],
  "observation.created": ["actionId", "observationId", "status", "code"],
  "context.updated": ["observationId"],
  "evidence.created": ["actionId", "evidenceId"],
  "retry.attempt.started": retryFields([
    "attemptId",
    "budgetId",
    "attemptNumber",
    "budgetAttemptNumber",
    "maxBudgetAttempts",
  ]),
  "retry.attempt.finished": retryFields([
    "attemptId",
    "budgetId",
    "attemptNumber",
    "budgetAttemptNumber",
    "durationMs",
    "outcome",
    "failureCategory",
    "failureCode",
    "next",
  ]),
  "retry.scheduled": retryFields([
    "afterAttemptId",
    "budgetId",
    "retryNumber",
    "nextAttemptNumber",
    "nextBudgetAttemptNumber",
    "delayMs",
    "delaySource",
    "nextAttemptAt",
    "failureCategory",
    "failureCode",
  ]),
  "retry.fallback.selected": retryFields([
    "fromLegId",
    "toLegId",
    "fromBudgetId",
    "toBudgetId",
    "fromTransport",
    "toTransport",
    "fallbackNumber",
    "reasonCode",
    "nextAttemptNumber",
  ]),
  "retry.exhausted": retryFields([
    "finalBudgetId",
    "reason",
    "totalAttempts",
    "totalRetryDelayMs",
    "lastFailureCategory",
    "lastFailureCode",
  ]),
  "retry.cancelled": retryFields([
    "phase",
    "budgetId",
    "attemptId",
    "attemptNumber",
    "attribution",
  ]),
};

export function projectRuntimeEventForHost(event: RuntimeEvent): RuntimeEvent {
  const source: Metadata = isRecord(event.payload)
    ? event.payload as unknown as Metadata
    : {};
  const payload: Metadata = {};

  for (const field of lifecycleFields[event.name]) {
    const projected = projectField(field, source[field]);
    if (projected !== undefined) {
      payload[field] = projected;
    }
  }

  return Object.freeze({
    schemaVersion: event.schemaVersion,
    id: event.id,
    runId: event.runId,
    name: event.name,
    taskId: event.taskId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    payload: Object.freeze(payload),
  }) as unknown as RuntimeEvent;
}

function terminalFields(): readonly string[] {
  return [
    "status",
    "code",
    "durationMs",
    "itemCount",
    "evidenceCount",
    "artifactCount",
    "errorCodes",
  ];
}

function retryFields(fields: readonly string[]): readonly string[] {
  return ["operationId", "owner", ...fields];
}

function projectField(field: string, value: unknown): unknown {
  if (field === "attribution") {
    return projectCancellationAttribution(value);
  }
  if (field === "plan") {
    return projectPlan(value);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)
  ) {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return Object.freeze([...value]);
  }
  return undefined;
}

function projectPlan(value: unknown): Metadata | undefined {
  if (!isRecord(value) || !Array.isArray(value.steps)) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    !Number.isSafeInteger(value.version) ||
    (value.status !== "active" && value.status !== "completed" && value.status !== "abandoned")
  ) {
    return undefined;
  }
  const steps: Metadata[] = [];
  for (const candidate of value.steps) {
    if (
      !isRecord(candidate) ||
      typeof candidate.step !== "string" ||
      (candidate.status !== "pending" &&
        candidate.status !== "in_progress" &&
        candidate.status !== "completed")
    ) {
      return undefined;
    }
    steps.push(Object.freeze({ step: candidate.step, status: candidate.status }));
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    status: value.status,
    steps: Object.freeze(steps),
  });
}

function projectCancellationAttribution(value: unknown): Metadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const attribution: Metadata = {};
  for (const field of ["requestId", "operation", "observedAt"] as const) {
    if (typeof value[field] === "string" && value[field].length > 0) {
      attribution[field] = value[field];
    }
  }
  return Object.keys(attribution).length === 3
    ? Object.freeze(attribution)
    : undefined;
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
