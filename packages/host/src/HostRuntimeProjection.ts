import type { Metadata } from "@agent-anything/shared";
import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core/events";

const lifecycleFields: Readonly<Record<RuntimeEventName, readonly string[]>> = {
  "run.started": ["runId", "status"],
  "run.item.appended": ["runId", "itemId", "itemKind", "itemSequence"],
  "run.completed": terminalFields(),
  "run.blocked": terminalFields(),
  "run.failed": terminalFields(),
  "run.cancelled": terminalFields(),
  "controller.started": ["runId", "iteration"],
  "controller.finished": [
    "runId",
    "iteration",
    "status",
    "code",
    "decisionKind",
    "controllerAction",
    "promptArchitectureVersion",
    "actionContractVersion",
    "toolCatalogVersion",
    "exposedToolNames",
    "requestedToolName",
    "patchOperation",
    "patchPath",
  ],
  "task.started": ["runId", "taskId"],
  "task.completed": ["runId", "taskId", "status", "durationMs"],
  "task.failed": ["runId", "taskId", "status", "code", "durationMs"],
  "loop.iteration.started": ["runId", "iteration"],
  "loop.iteration.finished": ["runId", "iteration", "status", "durationMs"],
  "planner.started": ["runId", "iteration"],
  "planner.finished": ["runId", "iteration", "status", "code", "durationMs"],
  "plan.created": ["runId", "plan"],
  "plan.updated": ["runId", "plan", "previousVersion", "transition"],
  "plan.completed": ["runId", "plan"],
  "plan.abandoned": ["runId", "plan", "terminalStatus", "reasonCode"],
  "action.prepared": [
    "runId",
    "actionId",
    "actionFingerprint",
    "category",
    "effectCount",
    "targetAssertionCount",
  ],
  "action.assessed": [
    "runId",
    "actionId",
    "actionFingerprint",
    "status",
    "owner",
    "code",
  ],
  "action.invalidated": [
    "runId",
    "actionId",
    "actionFingerprint",
    "phase",
    "owner",
    "code",
  ],
  "approval.requested": [
    "runId",
    "requestId",
    "actionId",
    "pendingVersion",
    "category",
    "reviewer",
    "phase",
    "reviewOperationId",
  ],
  "approval.resolved": [
    "runId",
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
    "runId",
    "actionId",
    "attemptId",
    "ordinal",
    "enforcement",
  ],
  "sandbox.attempt.resolved": [
    "runId",
    "actionId",
    "attemptId",
    "ordinal",
    "enforcement",
    "outcome",
    "code",
  ],
  "sandbox.escalation.proposed": [
    "runId",
    "actionId",
    "previousAttemptId",
    "previousActionFingerprint",
    "nextActionFingerprint",
    "deniedEffectKind",
  ],
  "tool.started": ["runId", "actionId", "toolName"],
  "tool.finished": [
    "runId",
    "actionId",
    "toolName",
    "status",
    "code",
    "toolResultStatus",
    "durationMs",
  ],
  "observation.created": ["runId", "actionId", "observationId", "status", "code"],
  "context.updated": ["runId", "observationId"],
  "evidence.created": ["runId", "actionId", "evidenceId", "evidenceRefs"],
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
  const source = isRecord(event.payload) ? event.payload : {};
  const payload: Metadata = {};

  for (const field of lifecycleFields[event.name]) {
    const projected = projectField(field, source[field]);
    if (projected !== undefined) {
      payload[field] = projected;
    }
  }

  return Object.freeze({
    id: event.id,
    name: event.name,
    taskId: event.taskId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    payload: Object.freeze(payload),
  });
}

function terminalFields(): readonly string[] {
  return [
    "runId",
    "status",
    "code",
    "durationMs",
    "evidenceCount",
    "artifactCount",
    "errorCodes",
  ];
}

function retryFields(fields: readonly string[]): readonly string[] {
  return ["type", "runId", "operationId", "owner", "occurredAt", ...fields];
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
  for (const field of ["requestId", "runId", "operation", "observedAt"] as const) {
    if (typeof value[field] === "string" && value[field].length > 0) {
      attribution[field] = value[field];
    }
  }
  return Object.keys(attribution).length === 4
    ? Object.freeze(attribution)
    : undefined;
}

function isRecord(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
