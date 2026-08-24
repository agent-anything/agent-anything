import type {
  RuntimeEventName,
  RuntimeEventPayloadMap,
  RuntimeContextTransitionOperationKind,
  RuntimeDescendantRunFailureCode,
  RuntimeOperationBindingKind,
  RuntimeOperationCorrelationKind,
  RuntimeOperationStatus,
  RuntimeRunProgressFactKind,
  RuntimeRunProgressReasonCode,
  RuntimeRunItemKind,
  RuntimeTerminalStatus,
} from "./RuntimeEventPayload.js";

export function snapshotRuntimeEventPayload<TName extends RuntimeEventName>(
  name: TName,
  payload: RuntimeEventPayloadMap[TName],
): RuntimeEventPayloadMap[TName] {
  record(payload, `${name}.payload`);
  switch (name) {
    case "run.started":
      return freeze({ status: exact(payload.status, "running", "run.started.status"), activeAgentId: token(payload.activeAgentId, "run.started.activeAgentId") }) as RuntimeEventPayloadMap[TName];
    case "run.item.appended":
      return freeze({ itemId: token(payload.itemId, "run.item.appended.itemId"), itemKind: oneOf(payload.itemKind, runItemKinds, "run.item.appended.itemKind"), itemSequence: positive(payload.itemSequence, "run.item.appended.itemSequence") }) as RuntimeEventPayloadMap[TName];
    case "run.progress.assessed":
      return freeze({
        checkpointSequence: positive(payload.checkpointSequence, "run.progress.assessed.checkpointSequence"),
        disposition: oneOf(payload.disposition, ["advanced", "unchanged", "repeated", "deferred"] as const, "run.progress.assessed.disposition"),
        reasonCode: oneOf(payload.reasonCode, progressReasonCodes, "run.progress.assessed.reasonCode"),
        factRefs: progressFactRefs(payload.factRefs, "run.progress.assessed.factRefs"),
        consecutiveNonAdvancingCheckpoints: nonNegativeInteger(payload.consecutiveNonAdvancingCheckpoints, "run.progress.assessed.consecutiveNonAdvancingCheckpoints"),
        correctionRounds: nonNegativeInteger(payload.correctionRounds, "run.progress.assessed.correctionRounds"),
        activeCorrectionRound: nullablePositive(payload.activeCorrectionRound, "run.progress.assessed.activeCorrectionRound"),
      }) as RuntimeEventPayloadMap[TName];
    case "run.progress.correction_requested":
      return freeze({
        checkpointSequence: positive(payload.checkpointSequence, "run.progress.correction_requested.checkpointSequence"),
        correctionRound: positive(payload.correctionRound, "run.progress.correction_requested.correctionRound"),
        reasonCode: oneOf(payload.reasonCode, progressReasonCodes, "run.progress.correction_requested.reasonCode"),
        factRefs: progressFactRefs(payload.factRefs, "run.progress.correction_requested.factRefs"),
      }) as RuntimeEventPayloadMap[TName];
    case "run.descendant.reserved":
    case "run.descendant.started":
      return descendant(name, payload) as unknown as RuntimeEventPayloadMap[TName];
    case "run.descendant.rejected":
      return freeze({
        relationId: nullableToken(payload.relationId, "run.descendant.rejected.relationId"),
        parentRunActionId: token(payload.parentRunActionId, "run.descendant.rejected.parentRunActionId"),
        childRunId: nullableToken(payload.childRunId, "run.descendant.rejected.childRunId"),
        depth: nullablePositive(payload.depth, "run.descendant.rejected.depth"),
        code: oneOf(payload.code, descendantFailureCodes, "run.descendant.rejected.code"),
        treeRevision: nonNegativeInteger(payload.treeRevision, "run.descendant.rejected.treeRevision"),
      }) as RuntimeEventPayloadMap[TName];
    case "run.descendant.settled": {
      const base = descendant(name, payload);
      const status = oneOf(payload.status, terminalStatuses, "run.descendant.settled.status");
      return freeze({
        ...base,
        status,
        code: status === "succeeded"
          ? exact(payload.code, null, "run.descendant.settled.code")
          : token(payload.code, "run.descendant.settled.code"),
      }) as unknown as RuntimeEventPayloadMap[TName];
    }
    case "context.transition.committed":
      return freeze({
        transitionId: token(payload.transitionId, "context.transition.committed.transitionId"),
        activeContextId: token(payload.activeContextId, "context.transition.committed.activeContextId"),
        baseVersion: nonNegativeInteger(payload.baseVersion, "context.transition.committed.baseVersion"),
        committedVersion: positive(payload.committedVersion, "context.transition.committed.committedVersion"),
        proposerOwner: token(payload.proposerOwner, "context.transition.committed.proposerOwner"),
        proposerKind: token(payload.proposerKind, "context.transition.committed.proposerKind"),
        causeKind: token(payload.causeKind, "context.transition.committed.causeKind"),
        causeId: nullableToken(payload.causeId, "context.transition.committed.causeId"),
        correlationId: nullableToken(payload.correlationId, "context.transition.committed.correlationId"),
        operationKinds: operationKindArray(payload.operationKinds, "context.transition.committed.operationKinds"),
      }) as RuntimeEventPayloadMap[TName];
    case "context.projection.completed":
      return contextProjectionCompleted(payload) as unknown as RuntimeEventPayloadMap[TName];
    case "run.completed":
    case "run.blocked":
    case "run.failed":
    case "run.cancelled":
      return terminal(name, payload) as unknown as RuntimeEventPayloadMap[TName];
    case "controller.started":
      return freeze({ turnId: token(payload.turnId, "controller.started.turnId"), iteration: positive(payload.iteration, "controller.started.iteration") }) as RuntimeEventPayloadMap[TName];
    case "controller.finished":
      return freeze({
        turnId: token(payload.turnId, "controller.finished.turnId"),
        iteration: positive(payload.iteration, "controller.finished.iteration"),
        status: oneOf(payload.status, ["decided", "failed", "interrupted"] as const, "controller.finished.status"),
        code: nullableToken(payload.code, "controller.finished.code"),
        decisionKind: payload.decisionKind === null ? null : oneOf(payload.decisionKind, ["advance", "propose_completion", "propose_stop"] as const, "controller.finished.decisionKind"),
      }) as RuntimeEventPayloadMap[TName];
    case "operation.started":
      return freeze({
        invocationId: token(payload.invocationId, "operation.started.invocationId"),
        operationNamespace: token(payload.operationNamespace, "operation.started.operationNamespace"),
        operationName: token(payload.operationName, "operation.started.operationName"),
        operationRevision: token(payload.operationRevision, "operation.started.operationRevision"),
        semanticOwner: token(payload.semanticOwner, "operation.started.semanticOwner"),
        bindingKind: oneOf(payload.bindingKind, bindingKinds, "operation.started.bindingKind"),
        correlationKind: oneOf(payload.correlationKind, correlationKinds, "operation.started.correlationKind"),
        parentInvocationId: nullableToken(payload.parentInvocationId, "operation.started.parentInvocationId"),
        parentRunActionId: nullableToken(payload.parentRunActionId, "operation.started.parentRunActionId"),
      }) as RuntimeEventPayloadMap[TName];
    case "operation.finished":
      return freeze({
        invocationId: token(payload.invocationId, "operation.finished.invocationId"),
        status: oneOf(payload.status, operationStatuses, "operation.finished.status"),
        code: nullableToken(payload.code, "operation.finished.code"),
        resultId: token(payload.resultId, "operation.finished.resultId"),
        lowerResultRefs: tokenArray(payload.lowerResultRefs, "operation.finished.lowerResultRefs"),
      }) as RuntimeEventPayloadMap[TName];
    case "interaction.opened":
      return freeze({
        requestId: token(payload.requestId, "interaction.opened.requestId"),
        protocolOwner: token(payload.protocolOwner, "interaction.opened.protocolOwner"),
        protocolKind: token(payload.protocolKind, "interaction.opened.protocolKind"),
        protocolRevision: token(payload.protocolRevision, "interaction.opened.protocolRevision"),
        subjectOwner: token(payload.subjectOwner, "interaction.opened.subjectOwner"),
        subjectKind: token(payload.subjectKind, "interaction.opened.subjectKind"),
        subjectId: token(payload.subjectId, "interaction.opened.subjectId"),
        subjectRevision: token(payload.subjectRevision, "interaction.opened.subjectRevision"),
        blockingScope: oneOf(payload.blockingScope, ["none", "branch", "run"] as const, "interaction.opened.blockingScope"),
        pendingVersion: positive(payload.pendingVersion, "interaction.opened.pendingVersion"),
        parentRunActionId: nullableToken(payload.parentRunActionId, "interaction.opened.parentRunActionId"),
      }) as RuntimeEventPayloadMap[TName];
    case "interaction.settled":
      return freeze({
        requestId: token(payload.requestId, "interaction.settled.requestId"),
        pendingVersion: positive(payload.pendingVersion, "interaction.settled.pendingVersion"),
        lifecycle: oneOf(payload.lifecycle, ["resolved", "expired", "cancelled", "invalidated", "failed"] as const, "interaction.settled.lifecycle"),
        code: nullableToken(payload.code, "interaction.settled.code"),
        terminalRecordId: token(payload.terminalRecordId, "interaction.settled.terminalRecordId"),
      }) as RuntimeEventPayloadMap[TName];
    case "validation.check.started":
      return freeze({
        snapshotRevision: nonNegativeInteger(payload.snapshotRevision, "validation.check.started.snapshotRevision"),
        attemptId: token(payload.attemptId, "validation.check.started.attemptId"),
        requirementId: token(payload.requirementId, "validation.check.started.requirementId"),
        origin: oneOf(payload.origin, ["controller", "trusted_automatic", "trusted_workflow", "owner_request"] as const, "validation.check.started.origin"),
      }) as RuntimeEventPayloadMap[TName];
    case "validation.check.finished":
      return freeze({
        snapshotRevision: nonNegativeInteger(payload.snapshotRevision, "validation.check.finished.snapshotRevision"),
        attemptId: token(payload.attemptId, "validation.check.finished.attemptId"),
        status: oneOf(payload.status, ["invalid", "unavailable", "denied", "cancelled", "timed_out", "failed", "partial", "completed"] as const, "validation.check.finished.status"),
        code: nullableToken(payload.code, "validation.check.finished.code"),
        durationMs: nonNegative(payload.durationMs, "validation.check.finished.durationMs"),
        coverageRatio: ratio(payload.coverageRatio, "validation.check.finished.coverageRatio"),
      }) as RuntimeEventPayloadMap[TName];
    case "validation.assessment.committed":
      return freeze({
        snapshotRevision: nonNegativeInteger(payload.snapshotRevision, "validation.assessment.committed.snapshotRevision"),
        requirementId: token(payload.requirementId, "validation.assessment.committed.requirementId"),
        assessmentId: token(payload.assessmentId, "validation.assessment.committed.assessmentId"),
        verdict: oneOf(payload.verdict, ["satisfied", "violated", "inconclusive"] as const, "validation.assessment.committed.verdict"),
      }) as RuntimeEventPayloadMap[TName];
    case "validation.gate.evaluated":
      return freeze({
        snapshotRevision: nonNegativeInteger(payload.snapshotRevision, "validation.gate.evaluated.snapshotRevision"),
        gateId: token(payload.gateId, "validation.gate.evaluated.gateId"),
        status: oneOf(payload.status, ["completion_eligible", "blocked_unassessed", "blocked_pending", "blocked_stale", "blocked_violated", "blocked_inconclusive", "invalid", "failed"] as const, "validation.gate.evaluated.status"),
        disposition: payload.disposition === null ? null : oneOf(payload.disposition, ["continue", "wait", "block", "fail"] as const, "validation.gate.evaluated.disposition"),
        reasonCodes: tokenArray(payload.reasonCodes, "validation.gate.evaluated.reasonCodes"),
      }) as RuntimeEventPayloadMap[TName];
  }
}

const runItemKinds: readonly RuntimeRunItemKind[] = ["controller_turn", "run_action", "observation", "state_transition", "pending_transition", "cancellation_transition", "validation_feedback", "progress_assessment", "progress_correction", "terminal_transition"];
const terminalStatuses: readonly RuntimeTerminalStatus[] = ["succeeded", "blocked", "failed", "cancelled"];
const bindingKinds: readonly RuntimeOperationBindingKind[] = ["internal", "direct", "hosted", "composite", "descendant_agent"];
const correlationKinds: readonly RuntimeOperationCorrelationKind[] = ["run_action", "run_request", "owner_operation", "evaluation_trial"];
const operationStatuses: readonly RuntimeOperationStatus[] = ["succeeded", "partial", "failed", "unavailable", "denied", "cancelled", "timed_out", "invalid", "unknown_effect"];
const progressReasonCodes: readonly RuntimeRunProgressReasonCode[] = ["new_trusted_fact", "equivalent_fact_repeated", "activity_without_structural_change", "plan_declaration_only", "progression_basis_changed", "required_work_pending", "no_committed_facts"];
const progressFactKinds: readonly RuntimeRunProgressFactKind[] = ["controller_turn", "run_action", "plan_update", "active_agent", "steering", "operation_result", "operation_rejected", "tool_rejected", "interaction_settlement", "descendant_settlement", "validation_feedback", "completion_gate", "evidence_ref", "artifact_ref", "required_pending", "unsupported_committed_fact"];
const contextTransitionOperationKinds: readonly RuntimeContextTransitionOperationKind[] = ["add", "replace", "invalidate", "remove"];
const descendantFailureCodes: readonly RuntimeDescendantRunFailureCode[] = [
  "descendant_run_start_cancelled",
  "descendant_run_deadline_exceeded",
  "descendant_run_depth_limit_exceeded",
  "descendant_run_total_limit_exceeded",
  "descendant_run_active_limit_exceeded",
  "descendant_run_preparation_failed",
  "descendant_agent_mismatch",
  "descendant_run_start_failed",
];

function descendant(
  name: "run.descendant.reserved" | "run.descendant.started" | "run.descendant.settled",
  input: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  return freeze({
    relationId: token(input.relationId, `${name}.relationId`),
    parentRunActionId: token(input.parentRunActionId, `${name}.parentRunActionId`),
    childRunId: token(input.childRunId, `${name}.childRunId`),
    depth: positive(input.depth, `${name}.depth`),
    treeRevision: nonNegativeInteger(input.treeRevision, `${name}.treeRevision`),
  });
}

function terminal(name: RuntimeEventName, input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const expected = name === "run.completed" ? "succeeded" : name.slice(4) as RuntimeTerminalStatus;
  const status = oneOf(input.status, terminalStatuses, `${name}.status`);
  if (status !== expected) throw new TypeError(`${name}.status must be ${expected}.`);
  return freeze({
    status,
    code: status === "succeeded" ? exact(input.code, null, `${name}.code`) : token(input.code, `${name}.code`),
    durationMs: nonNegative(input.durationMs, `${name}.durationMs`),
    itemCount: nonNegative(input.itemCount, `${name}.itemCount`),
    evidenceCount: nonNegative(input.evidenceCount, `${name}.evidenceCount`),
    artifactCount: nonNegative(input.artifactCount, `${name}.artifactCount`),
    errorCodes: tokenArray(input.errorCodes, `${name}.errorCodes`),
  });
}

function contextProjectionCompleted(input: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const outcome = oneOf(input.outcome, ["projected", "blocked"] as const, "context.projection.completed.outcome");
  const code = outcome === "projected"
    ? exact(input.code, null, "context.projection.completed.code")
    : token(input.code, "context.projection.completed.code");
  const consideredItemCount = nonNegativeInteger(input.consideredItemCount, "context.projection.completed.consideredItemCount");
  const projectedItemCount = nonNegativeInteger(input.projectedItemCount, "context.projection.completed.projectedItemCount");
  const includedCount = nonNegativeInteger(input.includedCount, "context.projection.completed.includedCount");
  const transformedCount = nonNegativeInteger(input.transformedCount, "context.projection.completed.transformedCount");
  const referencedCount = nonNegativeInteger(input.referencedCount, "context.projection.completed.referencedCount");
  const omittedCount = nonNegativeInteger(input.omittedCount, "context.projection.completed.omittedCount");
  const rejectedCount = nonNegativeInteger(input.rejectedCount, "context.projection.completed.rejectedCount");
  const blockedCount = nonNegativeInteger(input.blockedCount, "context.projection.completed.blockedCount");
  if (includedCount + transformedCount + referencedCount !== projectedItemCount) {
    throw new TypeError("context.projection.completed projected disposition counts must match projectedItemCount.");
  }
  if (projectedItemCount + omittedCount + rejectedCount + blockedCount !== consideredItemCount) {
    throw new TypeError("context.projection.completed disposition counts must match consideredItemCount.");
  }
  if ((outcome === "projected" && blockedCount !== 0) || (outcome === "blocked" && blockedCount === 0)) {
    throw new TypeError("context.projection.completed blockedCount must match outcome.");
  }
  const accountingUnit = oneOf(input.accountingUnit, ["bytes", "tokens"] as const, "context.projection.completed.accountingUnit");
  const budgetMaximum = nonNegativeInteger(input.budgetMaximum, "context.projection.completed.budgetMaximum");
  const projectedAmount = nonNegativeInteger(input.projectedAmount, "context.projection.completed.projectedAmount");
  if (projectedAmount > budgetMaximum) {
    throw new TypeError("context.projection.completed projectedAmount cannot exceed budgetMaximum.");
  }
  return freeze({
    manifestId: token(input.manifestId, "context.projection.completed.manifestId"),
    projectionId: token(input.projectionId, "context.projection.completed.projectionId"),
    requestId: token(input.requestId, "context.projection.completed.requestId"),
    activeContextId: token(input.activeContextId, "context.projection.completed.activeContextId"),
    activeContextVersion: nonNegativeInteger(input.activeContextVersion, "context.projection.completed.activeContextVersion"),
    profileId: token(input.profileId, "context.projection.completed.profileId"),
    profileRevision: token(input.profileRevision, "context.projection.completed.profileRevision"),
    policyId: token(input.policyId, "context.projection.completed.policyId"),
    policyRevision: token(input.policyRevision, "context.projection.completed.policyRevision"),
    estimatorId: token(input.estimatorId, "context.projection.completed.estimatorId"),
    estimatorRevision: token(input.estimatorRevision, "context.projection.completed.estimatorRevision"),
    accountingUnit,
    budgetMaximum,
    consideredItemCount,
    projectedItemCount,
    projectedAmount,
    includedCount,
    transformedCount,
    referencedCount,
    omittedCount,
    rejectedCount,
    blockedCount,
    outcome,
    code,
  });
}

function record(value: unknown, field: string): asserts value is Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object.`); }
function token(value: unknown, field: string): string { if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new TypeError(`${field} must be a canonical token.`); return value; }
function nullableToken(value: unknown, field: string): string | null { return value === null ? null : token(value, field); }
function nullablePositive(value: unknown, field: string): number | null { return value === null ? null : positive(value, field); }
function positive(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer.`); return value as number; }
function nonNegative(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be non-negative.`); return value; }
function nonNegativeInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${field} must be a non-negative integer.`); return value as number; }
function exact<T>(value: unknown, expected: T, field: string): T { if (value !== expected) throw new TypeError(`${field} has an invalid value.`); return expected; }
function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${field} has an unsupported value.`); return value as T; }
function tokenArray(value: unknown, field: string): readonly string[] { if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`); return Object.freeze(value.map((entry, index) => token(entry, `${field}[${index}]`))); }
function progressFactRefs(value: unknown, field: string): readonly Readonly<{ kind: RuntimeRunProgressFactKind; owner: string; subjectId: string | null; revision: string | null }>[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`);
  return Object.freeze(value.map((entry, index) => {
    record(entry, `${field}[${index}]`);
    return freeze({
      kind: oneOf(entry.kind, progressFactKinds, `${field}[${index}].kind`),
      owner: token(entry.owner, `${field}[${index}].owner`),
      subjectId: nullableToken(entry.subjectId, `${field}[${index}].subjectId`),
      revision: nullableToken(entry.revision, `${field}[${index}].revision`),
    });
  }));
}
function operationKindArray(value: unknown, field: string): readonly RuntimeContextTransitionOperationKind[] { if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array.`); return Object.freeze(value.map((entry, index) => oneOf(entry, contextTransitionOperationKinds, `${field}[${index}]`))); }
function ratio(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new TypeError(`${field} must be between 0 and 1.`); return value; }
function freeze<T extends Record<string, unknown>>(value: T): Readonly<T> { return Object.freeze(value); }
