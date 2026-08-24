
import type {
  RuntimeEvent,
  RuntimeEventName,
} from "@agent-anything/observability/events";

const lifecycleFields: Readonly<Record<RuntimeEventName, readonly string[]>> = {
  "run.started": ["status", "activeAgentId"],
  "run.item.appended": ["itemId", "itemKind", "itemSequence"],
  "run.progress.assessed": [
    "checkpointSequence",
    "disposition",
    "reasonCode",
    "factRefs",
    "consecutiveNonAdvancingCheckpoints",
    "correctionRounds",
    "activeCorrectionRound",
  ],
  "run.progress.correction_requested": [
    "checkpointSequence",
    "correctionRound",
    "reasonCode",
    "factRefs",
  ],
  "run.descendant.reserved": descendantFields(),
  "run.descendant.started": descendantFields(),
  "run.descendant.rejected": [
    "relationId", "parentRunActionId", "childRunId", "depth", "code", "treeRevision",
  ],
  "run.descendant.settled": [
    ...descendantFields(), "status", "code",
  ],
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
  "controller.tool_exposure.resolved": [
    "turnId",
    "iteration",
    "controllerRequestId",
    "manifestId",
    "selectionRevision",
    "contentRevision",
    "basisRevision",
    "proofId",
    "catalogRevision",
    "exposedToolCount",
    "omittedToolCount",
    "omissionReasons",
  ],
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
    lineage: projectLineage(event),
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    payload: Object.freeze(payload),
  }) as unknown as RuntimeEvent;
}

function descendantFields(): readonly string[] {
  return ["relationId", "parentRunActionId", "childRunId", "depth", "treeRevision"];
}

function projectLineage(event: RuntimeEvent): RuntimeEvent["lineage"] {
  if (event.lineage.kind === "root") {
    return Object.freeze({
      kind: "root" as const,
      root: Object.freeze({ id: event.lineage.root.id }),
      depth: 0 as const,
    });
  }
  return Object.freeze({
    kind: "descendant" as const,
    root: Object.freeze({ id: event.lineage.root.id }),
    parent: Object.freeze({ id: event.lineage.parent.id }),
    parentRunAction: Object.freeze({
      run: Object.freeze({ id: event.lineage.parentRunAction.run.id }),
      id: event.lineage.parentRunAction.id,
      sequence: event.lineage.parentRunAction.sequence,
    }),
    relation: Object.freeze({ id: event.lineage.relation.id }),
    depth: event.lineage.depth,
  });
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
  if (field === "factRefs") return projectProgressFactRefs(value);
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

function projectProgressFactRefs(value: unknown): readonly Readonly<Record<string, string | null>>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const projected: Readonly<Record<string, string | null>>[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const { kind, owner, subjectId, revision } = candidate;
    if (
      typeof kind !== "string" || kind.length === 0 ||
      typeof owner !== "string" || owner.length === 0 ||
      !(subjectId === null || typeof subjectId === "string") ||
      !(revision === null || typeof revision === "string")
    ) return undefined;
    projected.push(Object.freeze({ kind, owner, subjectId, revision }));
  }
  return Object.freeze(projected);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
