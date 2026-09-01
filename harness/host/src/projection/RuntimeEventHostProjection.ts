
import type {
  RuntimeEvent,
  RuntimeEventName,
} from "@agent-anything/observability/events";

const lifecycleFields: Readonly<Record<RuntimeEventName, readonly string[]>> = {
  "run.started": [
    "status",
    "activeAgentId",
    "activeAgentRevision",
    "instructionBindingId",
    "instructionBindingRevision",
  ],
  "run.item.appended": ["itemId", "itemKind", "itemSequence"],
  "run.stop.reviewed": [
    "reviewSequence",
    "decision",
    "checkCount",
    "limitationCount",
    "requiredFeedbackRounds",
    "advisoryFeedbackRounds",
  ],
  "run.stop.feedback_requested": [
    "reviewSequence",
    "owner",
    "severity",
    "round",
    "code",
  ],
  "run.descendant.reserved": descendantFields(),
  "run.descendant.started": descendantFields(),
  "run.descendant.rejected": [
    ...descendantDispatchFields(),
    "relationId", "parentRunActionId", "childRunId", "depth", "code", "treeRevision",
  ],
  "run.descendant.settled": [
    ...descendantFields(),
    "status", "code", "resultId", "resultRevision",
    "expectationPresentCount", "expectationUnmetCount", "evidenceCount", "artifactCount",
    "verificationStatus", "effectStatus", "uncertaintyCount", "controllerTurns", "actions",
    "modelUsageStatus", "limitStatus", "exhaustedLimit",
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
  "verification.check.started": [
    "snapshotRevision", "attemptId", "requirementId", "origin",
  ],
  "verification.check.finished": [
    "snapshotRevision", "attemptId", "status", "code", "durationMs", "coverageRatio",
  ],
  "verification.assessment.committed": [
    "snapshotRevision", "requirementId", "assessmentId", "verdict",
  ],
  "verification.gate.evaluated": [
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
  return [
    ...descendantDispatchFields(),
    "relationId", "relationKind", "parentRunActionId", "childRunId", "childAgentId", "childAgentRevision",
    "requestId", "requestRevision", "dependencyResultId", "replacedResultId", "contextSourceCount",
    "authorityDerivationId", "limitDerivationId", "depth", "treeRevision",
  ];
}

function descendantDispatchFields(): readonly string[] {
  return [
    "requestedDispatchForm", "controllerRequestId", "controllerTurnId",
    "candidateIndex", "siblingIndex", "siblingCount",
  ];
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
