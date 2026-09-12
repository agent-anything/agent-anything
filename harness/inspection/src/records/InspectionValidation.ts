import type { InspectionJson, InspectionRecordInput, InspectionSubjectRef } from "./InspectionRecord.js";
import { validateExecutionFlowDefinition, type ExecutionFlowDefinition } from "@agent-anything/observability/execution-flow";

const kinds = new Set(["run", "turn", "request", "provider-attempt", "call", "operation", "action", "attempt", "control", "definition", "artifact", "context", "contribution", "hook", "event", "flow-definition", "flow-invocation", "flow-step"]);
const relationKinds = ["contains", "descendant", "binding", "materializes", "trigger", "produces", "transforms", "delivers", "includes", "omits", "prerequisite", "retry", "settles", "cause", "next", "call", "return", "spawn", "join", "resume"];
type Check = (value: unknown) => boolean;
const text: Check = (value) => typeof value === "string" && value.length <= 4096;
const identity: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const integer: Check = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
const bool: Check = (value) => typeof value === "boolean";
const nullable = (check: Check): Check => (value) => value === null || check(value);
const oneOf = (...values: string[]): Check => (value) => typeof value === "string" && values.includes(value);
const array = (check: Check): Check => (value) => Array.isArray(value) && value.length <= 2048 && value.every(check);
function shape(fields: Record<string, Check>): Check {
  return (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(fields).length && Object.entries(fields).every(([key, check]) => check((value as Record<string, unknown>)[key]));
}
const payloads: Record<string, Record<string, Check>> = {
  flow_definition: { definition: (value) => { try { validateExecutionFlowDefinition(value as ExecutionFlowDefinition); return true; } catch { return false; } } },
  flow_invocation: { observation: flowObservation("invocation_entered", "invocation_exited") },
  flow_step: { observation: flowObservation("step_entered", "step_exited") },
  flow_constraint: { observation: flowObservation("constraint") },
  flow_link: { observation: flowObservation("link") },
  definition: { definitionKind: oneOf("tool", "agent", "provider", "instructions", "hook"), name: text, revision: identity, enabled: nullable(bool) },
  snapshot: { status: identity, revision: integer, agentId: nullable(identity), parentRunId: nullable(identity), taskId: nullable(identity) },
  lifecycle: { revision: identity, states: array(identity), transitions: array(shape({ id: identity, from: identity, to: identity, trigger: text })) },
  transition: { from: nullable(identity), to: identity, revision: integer, transitionId: nullable(identity), reasonCode: nullable(identity) },
  exposure: { requestId: identity, selected: array(identity), exposed: array(identity), omitted: array(shape({ id: identity, reason: text })) },
  request: { purpose: identity, providerId: identity, model: nullable(text), compositionId: nullable(identity), messageCount: integer, toolCount: integer },
  response: { status: identity, finishReason: nullable(text), callCount: integer, inputTokens: nullable(integer), outputTokens: nullable(integer) },
  transport: { phase: oneOf("started", "settled", "rejected"), requestId: identity, providerId: identity, method: identity, endpoint: text, httpStatus: nullable(integer), status: identity, code: nullable(identity), encodedBytes: nullable(integer) },
  scheduling: { position: integer, disposition: oneOf("admitted", "rejected", "queued", "dispatched", "settled", "invalidated"), rule: identity, reason: nullable(text), groupId: nullable(identity) },
  execution: { phase: oneOf("started", "settled", "pending"), executionKind: identity, status: identity, code: nullable(identity), effectCertainty: nullable(identity) },
  transfer: { stage: oneOf("produced", "transformed", "delivered", "included", "omitted"), producerId: identity, consumerId: nullable(identity), operation: nullable(text) },
  dependency: { condition: oneOf("settled", "succeeded", "result"), status: oneOf("registered", "satisfied", "unsatisfied"), prerequisiteId: identity, dependentId: identity },
  event: { name: text, sequence: nullable(integer), code: nullable(identity) },
  interval: { phase: oneOf("started", "settled"), activity: oneOf("run", "controller", "provider", "operation", "action", "attempt", "wait"), status: nullable(identity), clock: identity },
};

function flowObservation(...types: string[]): Check {
  const ref = shape({owner: identity, id: identity, revision: identity, contentDigest: identity});
  const occurrence = shape({owner: identity, runId: identity, invocationId: identity, stepExecutionId: nullable(identity)});
  const basis: Check = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length <= 64 && Object.values(value).every(item => item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || text(item));
  const subject: Check = value => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const fields = value as Record<string, unknown>;
    return Object.keys(fields).every(key => ["owner", "kind", "id", "revision", "contentId", "runId"].includes(key)) && identity(fields.owner) && identity(fields.kind) && identity(fields.id) && nullable(identity)(fields.revision) && (fields.contentId === undefined || identity(fields.contentId)) && (fields.runId === undefined || nullable(identity)(fields.runId));
  };
  const disposition = oneOf("returned", "yielded", "failed", "cancelled", "interrupted");
  return value => {
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    const common = {kind: oneOf(...types), definition: ref, runId: identity, invocationId: identity, sequence: integer, occurredAt: (time: unknown) => typeof time === "string" && Number.isFinite(Date.parse(time))};
    const extra: Record<string, Record<string, Check>> = {
      invocation_entered: {caller: nullable(occurrence), subjects: array(subject)},
      invocation_exited: {exit: nullable(occurrence), disposition, subjects: array(subject)},
      step_entered: {stepId: identity, stepExecutionId: identity, inputs: array(subject), basis},
      step_exited: {stepId: identity, stepExecutionId: identity, disposition, branch: nullable(text), outputs: array(subject), basis},
      constraint: {stepId: identity, stepExecutionId: identity, checkId: identity, disposition: oneOf("passed", "not_satisfied", "not_applicable", "not_evaluated", "error"), configuration: nullable(subject), basis},
      link: {from: occurrence, to: occurrence, relation: oneOf("next", "call", "return", "spawn", "join", "resume"), transitionId: nullable(identity), establishedBy: nullable(subject)},
    };
    return types.includes(String(record.kind)) && shape({...common, ...extra[String(record.kind)]})(record);
  };
}

export function snapshotInspectionJson(value: unknown, maxBytes = 64 * 1024): InspectionJson {
  let size = 0;
  let items = 0;
  const visit = (current: unknown, depth: number): InspectionJson => {
    if (++items > 20000 || depth > 32) throw new TypeError("Inspection value complexity exceeds its limit.");
    if (current === null || typeof current === "boolean") { size += 5; return current; }
    if (typeof current === "number" && Number.isFinite(current)) { size += 24; return current; }
    if (typeof current === "string") {
      size += current.length * 3 + 2;
      if (size > maxBytes) throw new TypeError("Inspection value exceeds its byte limit.");
      return current;
    }
    if (Array.isArray(current)) {
      if (current.length > 20000) throw new TypeError("Inspection array exceeds its item limit.");
      const result: InspectionJson[] = [];
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, index);
        if (!descriptor || !("value" in descriptor)) throw new TypeError("Inspection cannot invoke accessors.");
        result.push(visit(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    if (typeof current !== "object" || current === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(current))) throw new TypeError("Inspection accepts plain data only.");
    const result: Record<string, InspectionJson> = Object.create(null);
    const keys = Object.keys(current);
    if (keys.length > 20000) throw new TypeError("Inspection object exceeds its item limit.");
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (!("value" in descriptor) || key === "__proto__" || key === "constructor") throw new TypeError("Inspection cannot invoke accessors.");
      size += key.length * 3 + 3;
      if (size > maxBytes) throw new TypeError("Inspection value exceeds its byte limit.");
      result[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const result = visit(value, 0);
  if (size > maxBytes) throw new TypeError("Inspection value exceeds its byte limit.");
  return result;
}

export function validateInspectionRef(ref: InspectionSubjectRef): void {
  for (const value of [ref.sourceId, ref.datasetId, ref.owner, ref.id]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new TypeError("Invalid inspection identity.");
  }
  if (!kinds.has(ref.kind)) throw new TypeError("Unknown inspection subject kind.");
  for (const value of [ref.runId, ref.revision]) {
    if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > 512)) throw new TypeError("Invalid inspection scope.");
  }
}

export function validateInspectionInput(input: InspectionRecordInput): void {
  validateInspectionRef(input.subject);
  if (input.id !== undefined && (typeof input.id !== "string" || input.id.length === 0 || input.id.length > 512)) throw new TypeError("Invalid inspection record ID.");
  if (input.occurredAt !== null && !Number.isFinite(Date.parse(input.occurredAt))) throw new TypeError("Invalid observation time.");
  if (input.ownerSequence != null && (!Number.isSafeInteger(input.ownerSequence) || input.ownerSequence < 0)) throw new TypeError("Invalid owner sequence.");
  const fields = payloads[input.payload.kind];
  if (!fields || !shape({ kind: oneOf(input.payload.kind), ...fields })(input.payload)) throw new TypeError("Invalid inspection payload.");
  for (const link of input.links ?? []) {
    validateInspectionRef(link.from);
    validateInspectionRef(link.to);
    if (![link.from, link.to].every((ref) => ref.sourceId === input.subject.sourceId && ref.datasetId === input.subject.datasetId) || !relationKinds.includes(link.kind)) throw new TypeError("Invalid inspection relation scope.");
    const location = nullable(shape({ contentId: nullable(identity), partId: nullable(identity), jsonPointer: nullable(text), stage: identity }));
    if (!location(link.sourceLocation) || !location(link.targetLocation) || !nullable(text)(link.operation) || !nullable(oneOf("settled", "succeeded", "result"))(link.condition)) throw new TypeError("Invalid inspection relation.");
    if (link.kind === "prerequisite" && link.condition === null) throw new TypeError("A prerequisite needs its condition.");
  }
  if ((input.links?.length ?? 0) > 256 || (input.contents?.length ?? 0) > 32) throw new TypeError("Inspection record exceeds its item limit.");
}
