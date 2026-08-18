
import type {
  RuntimeEvent,
  RuntimeEventName,
} from "@agent-anything/observability/events";

const lifecycleFields: Readonly<Record<RuntimeEventName, readonly string[]>> = {
  "run.started": ["status", "activeAgentId"],
  "run.item.appended": ["itemId", "itemKind", "itemSequence"],
  "context.transition.committed": [
    "transitionId",
    "activeContextId",
    "baseVersion",
    "committedVersion",
    "proposerOwner",
    "proposerKind",
    "causeKind",
    "causeId",
    "correlationId",
    "operationKinds",
  ],
  "context.projection.completed": [
    "manifestId",
    "projectionId",
    "requestId",
    "activeContextId",
    "activeContextVersion",
    "profileId",
    "profileRevision",
    "policyId",
    "policyRevision",
    "estimatorId",
    "estimatorRevision",
    "accountingUnit",
    "budgetMaximum",
    "consideredItemCount",
    "projectedItemCount",
    "projectedAmount",
    "includedCount",
    "transformedCount",
    "referencedCount",
    "omittedCount",
    "rejectedCount",
    "blockedCount",
    "outcome",
    "code",
  ],
  "run.completed": terminalFields(),
  "run.blocked": terminalFields(),
  "run.failed": terminalFields(),
  "run.cancelled": terminalFields(),
  "controller.started": ["turnId", "iteration"],
  "controller.finished": [
    "turnId",
    "iteration",
    "status",
    "code",
    "decisionKind",
  ],
  "operation.started": [
    "invocationId",
    "operationNamespace",
    "operationName",
    "operationRevision",
    "semanticOwner",
    "bindingKind",
    "correlationKind",
    "parentInvocationId",
    "parentRunActionId",
  ],
  "operation.finished": [
    "invocationId",
    "status",
    "code",
    "resultId",
    "lowerResultRefs",
  ],
  "interaction.opened": [
    "requestId",
    "protocolOwner",
    "protocolKind",
    "protocolRevision",
    "subjectOwner",
    "subjectKind",
    "subjectId",
    "subjectRevision",
    "blockingScope",
    "pendingVersion",
    "parentRunActionId",
  ],
  "interaction.settled": [
    "requestId",
    "pendingVersion",
    "lifecycle",
    "code",
    "terminalRecordId",
  ],
  "validation.check.started": [
    "snapshotRevision", "attemptId", "requirementId", "origin",
  ],
  "validation.check.finished": [
    "snapshotRevision", "attemptId", "status", "code", "durationMs", "coverageRatio",
  ],
  "validation.assessment.committed": [
    "snapshotRevision", "requirementId", "assessmentId", "verdict",
  ],
  "validation.gate.evaluated": [
    "snapshotRevision", "gateId", "status", "disposition", "reasonCodes",
  ],
};

export function projectRuntimeEventForHost(event: RuntimeEvent): RuntimeEvent {
  const source: Readonly<Record<string, unknown>> = isRecord(event.payload)
    ? event.payload as unknown as Readonly<Record<string, unknown>>
    : {};
  const payload: Record<string, unknown> = {};

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

function projectField(field: string, value: unknown): unknown {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
