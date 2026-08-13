import type {
  RuntimeEventName,
  RuntimeEventPayloadMap,
  RuntimeOperationBindingKind,
  RuntimeOperationCorrelationKind,
  RuntimeOperationStatus,
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
  }
}

const runItemKinds: readonly RuntimeRunItemKind[] = ["controller_turn", "run_action", "observation", "state_transition", "pending_transition", "cancellation_transition", "terminal_transition"];
const terminalStatuses: readonly RuntimeTerminalStatus[] = ["succeeded", "blocked", "failed", "cancelled"];
const bindingKinds: readonly RuntimeOperationBindingKind[] = ["internal", "direct", "hosted", "composite", "descendant_agent"];
const correlationKinds: readonly RuntimeOperationCorrelationKind[] = ["run_action", "run_request", "owner_operation", "evaluation_trial"];
const operationStatuses: readonly RuntimeOperationStatus[] = ["succeeded", "partial", "failed", "unavailable", "denied", "cancelled", "timed_out", "invalid", "unknown_effect"];

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

function record(value: unknown, field: string): asserts value is Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object.`); }
function token(value: unknown, field: string): string { if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new TypeError(`${field} must be a canonical token.`); return value; }
function nullableToken(value: unknown, field: string): string | null { return value === null ? null : token(value, field); }
function positive(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer.`); return value as number; }
function nonNegative(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be non-negative.`); return value; }
function exact<T>(value: unknown, expected: T, field: string): T { if (value !== expected) throw new TypeError(`${field} has an invalid value.`); return expected; }
function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`${field} has an unsupported value.`); return value as T; }
function tokenArray(value: unknown, field: string): readonly string[] { if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`); return Object.freeze(value.map((entry, index) => token(entry, `${field}[${index}]`))); }
function freeze<T extends Record<string, unknown>>(value: T): Readonly<T> { return Object.freeze(value); }
