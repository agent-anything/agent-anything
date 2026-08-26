import type { AgentTask } from "@agent-anything/agent-core/task";
import type { ContextJsonValue } from "@agent-anything/context/contract";
import type { ContextContribution, ContextInstructionRole } from "@agent-anything/context/contribution";
import { measureContextPayload } from "@agent-anything/context/contribution";
import type { ContextAdmissionProfile } from "@agent-anything/context/active-context";
import type { PlanProjection } from "../plan/index.js";
import type { RunProgressCorrectionFeedback } from "../progress/index.js";
import type { RunObservation, RunState } from "../run/index.js";
import type {
  DelegationContextMaterial,
  DelegationTaskPreparation,
} from "../delegation/DelegationRequest.js";

const SENSITIVE_KEY = /(?:authorization|credential|password|secret|token|api[-_]?key)/i;
const MAX_DEPTH = 8;
const MAX_OBJECT_ENTRIES = 128;
const MAX_ARRAY_ITEMS = 128;
const MAX_STRING_LENGTH = 16_000;

export interface CreateRunContextContributionInput {
  readonly id: string;
  readonly revision: string;
  readonly runId: string;
  readonly owner: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceRevision: string | null;
  readonly observedAt: string;
  readonly payload: ContextJsonValue | string;
  readonly payloadKind: "structured" | "text";
  readonly retention: "history" | "current";
  readonly replacementKey: string | null;
  readonly instructionRole: ContextInstructionRole;
  readonly necessity: "mandatory" | "optional";
  readonly precedence: number;
  readonly audiences: readonly string[];
  readonly provenanceKind: string;
  readonly provenanceId: string;
  readonly provenanceRevision: string;
}

export function createRunContextContribution(input: CreateRunContextContributionInput): ContextContribution {
  const payload = input.payloadKind === "text"
    ? Object.freeze({ kind: "text" as const, text: input.payload as string })
    : Object.freeze({ kind: "structured" as const, value: input.payload as ContextJsonValue });
  return Object.freeze({
    ref: Object.freeze({ id: input.id, revision: input.revision }),
    source: Object.freeze({ owner: input.owner, kind: input.sourceKind, id: input.sourceId, revision: input.sourceRevision, observedAt: input.observedAt }),
    payload,
    scope: Object.freeze({ runId: input.runId, ownerScope: null }),
    disclosure: Object.freeze({ sensitivity: "internal" as const, audiences: Object.freeze([...input.audiences]) }),
    handling: Object.freeze({
      retention: input.retention,
      replacementKey: input.replacementKey,
      instructionRole: input.instructionRole,
      necessity: input.necessity,
      precedence: input.precedence,
      allowedTransformations: Object.freeze(["truncate" as const, "redact" as const, "reference" as const]),
    }),
    provenance: Object.freeze([Object.freeze({
      owner: input.owner,
      kind: input.provenanceKind,
      id: input.provenanceId,
      revision: input.provenanceRevision,
    })]),
    createdAt: input.observedAt,
    accounting: measureContextPayload(payload),
  });
}

export function createTaskContextContribution(input: { readonly id: string; readonly runId: string; readonly task: AgentTask }): ContextContribution {
  return createRunContextContribution({
    id: input.id, revision: "1", runId: input.runId, owner: "agent-core",
    sourceKind: "task", sourceId: input.task.id, sourceRevision: "1", observedAt: input.task.createdAt,
    payload: toContextJsonValue({ kind: input.task.kind, input: input.task.input }), payloadKind: "structured",
    retention: "current", replacementKey: "task", instructionRole: "user", necessity: "mandatory",
    precedence: 100, audiences: Object.freeze(["runtime"]), provenanceKind: "task",
    provenanceId: input.task.id, provenanceRevision: "1",
  });
}

export function createDelegationRootPurposeContextContribution(input: {
  readonly id: string;
  readonly runId: string;
  readonly material: DelegationContextMaterial;
  readonly createdAt: string;
}): ContextContribution {
  return createRunContextContribution({
    id: input.id,
    revision: input.material.ref.revision,
    runId: input.runId,
    owner: input.material.ref.owner,
    sourceKind: input.material.ref.kind,
    sourceId: input.material.ref.id,
    sourceRevision: input.material.ref.revision,
    observedAt: input.createdAt,
    payload: input.material.payload,
    payloadKind: "structured",
    retention: "current",
    replacementKey: "delegation_root_purpose",
    instructionRole: "user",
    necessity: "mandatory",
    precedence: 99,
    audiences: Object.freeze(["model", "runtime"]),
    provenanceKind: "root_task",
    provenanceId: input.material.ref.id,
    provenanceRevision: input.material.ref.revision,
  });
}

export function createDelegationPredecessorContextContribution(input: {
  readonly id: string;
  readonly runId: string;
  readonly material: DelegationContextMaterial;
  readonly createdAt: string;
}): ContextContribution {
  return createRunContextContribution({
    id: input.id,
    revision: input.material.ref.revision,
    runId: input.runId,
    owner: input.material.ref.owner,
    sourceKind: input.material.ref.kind,
    sourceId: input.material.ref.id,
    sourceRevision: input.material.ref.revision,
    observedAt: input.createdAt,
    payload: input.material.payload,
    payloadKind: "structured",
    retention: "history",
    replacementKey: null,
    instructionRole: "data",
    necessity: "mandatory",
    precedence: 80,
    audiences: Object.freeze(["model", "runtime"]),
    provenanceKind: "delegation_result",
    provenanceId: input.material.ref.id,
    provenanceRevision: input.material.ref.revision,
  });
}

export function createObservationContextContribution(input: { readonly id: string; readonly observation: RunObservation }): ContextContribution {
  return createRunContextContribution({
    id: input.id, revision: "1", runId: input.observation.runId, owner: input.observation.owner,
    sourceKind: "run_observation", sourceId: input.observation.id, sourceRevision: "1", observedAt: input.observation.createdAt,
    payload: toContextJsonValue({ kind: "run_observation", observation: input.observation }), payloadKind: "structured",
    retention: "history", replacementKey: null, instructionRole: "data", necessity: "optional",
    precedence: 60, audiences: Object.freeze(["model", "product"]), provenanceKind: "run_action",
    provenanceId: input.observation.runAction.id, provenanceRevision: String(input.observation.runAction.sequence),
  });
}

export function createSteeringContextContribution(input: { readonly id: string; readonly revision: string; readonly runId: string; readonly commandId: string; readonly instruction: string; readonly createdAt: string }): ContextContribution {
  return createRunContextContribution({
    id: input.id, revision: input.revision, runId: input.runId, owner: "run-steering",
    sourceKind: "steering_instruction", sourceId: input.commandId, sourceRevision: input.revision, observedAt: input.createdAt,
    payload: input.instruction, payloadKind: "text", retention: "history", replacementKey: null,
    instructionRole: "user", necessity: "mandatory", precedence: 90, audiences: Object.freeze(["model"]),
    provenanceKind: "steering_command", provenanceId: input.commandId, provenanceRevision: input.revision,
  });
}

export function createProgressCorrectionContextContribution(input: {
  readonly id: string;
  readonly revision: string;
  readonly runId: string;
  readonly feedback: RunProgressCorrectionFeedback;
  readonly createdAt: string;
}): ContextContribution {
  return createRunContextContribution({
    id: input.id,
    revision: input.revision,
    runId: input.runId,
    owner: "agent-runtime",
    sourceKind: "run_progress_correction",
    sourceId: input.runId,
    sourceRevision: input.revision,
    observedAt: input.createdAt,
    payload: toContextJsonValue({
      kind: "run_progress_correction",
      correctionRound: input.feedback.correctionRound,
      reasonCode: input.feedback.reasonCode,
      factRefs: input.feedback.factRefs,
      guidance: [
        "Reassess the objective and current committed facts.",
        "Choose a materially different path, request clarification, propose completion, or stop when no safe path remains.",
      ],
    }),
    payloadKind: "structured",
    retention: "current",
    replacementKey: "run_progress_correction",
    instructionRole: "data",
    necessity: "mandatory",
    precedence: 92,
    audiences: Object.freeze(["model"]),
    provenanceKind: "run_progress_assessment",
    provenanceId: `${input.runId}:${input.feedback.assessment.checkpointSequence}`,
    provenanceRevision: input.revision,
  });
}

export function createCurrentRunContextContributions(input: {
  readonly runStateId: string;
  readonly planId: string;
  readonly revision: string;
  readonly state: RunState;
  readonly plan: PlanProjection | null;
  readonly createdAt: string;
}): readonly ContextContribution[] {
  const base = {
    revision: input.revision, runId: input.state.run.id, owner: "agent-runtime",
    sourceRevision: input.revision, observedAt: input.createdAt, payloadKind: "structured" as const,
    retention: "current" as const, instructionRole: "data" as const, necessity: "mandatory" as const,
    audiences: Object.freeze(["model"]), provenanceKind: "run_state", provenanceId: input.state.run.id,
    provenanceRevision: input.revision,
  };
  return Object.freeze([
    createRunContextContribution({
      ...base, id: input.runStateId, sourceKind: "run_state", sourceId: input.state.run.id,
      payload: toContextJsonValue({ kind: "run_state", revision: input.state.revision, status: input.state.status, activeAgent: input.state.activeAgent, pending: input.state.pending }),
      replacementKey: "run_state", precedence: 95,
    }),
    createRunContextContribution({
      ...base, id: input.planId, sourceKind: "run_plan", sourceId: input.state.run.id,
      payload: toContextJsonValue({ kind: "run_plan", plan: input.plan }), replacementKey: "run_plan", precedence: 85,
    }),
  ]);
}

export function toContextJsonValue(value: unknown): ContextJsonValue {
  return sanitize(value, 0, new WeakSet<object>());
}

export function createTaskContextAdmissionProfile(): ContextAdmissionProfile {
  return admissionProfile({
    owner: "agent-core",
    sourceKinds: ["task"],
    audiences: ["runtime"],
    retention: ["current"],
    instructionRoles: ["user"],
    necessities: ["mandatory"],
    maximumPrecedence: 100,
  });
}

export function createDelegationRootPurposeContextAdmissionProfile(
  material: DelegationContextMaterial,
): ContextAdmissionProfile {
  return admissionProfile({
    owner: material.ref.owner,
    sourceKinds: ["root_task_purpose"],
    audiences: ["model", "runtime"],
    retention: ["current"],
    instructionRoles: ["user"],
    necessities: ["mandatory"],
    maximumPrecedence: 99,
  });
}

export function createDelegationPredecessorContextAdmissionProfile(
  material: DelegationContextMaterial,
): ContextAdmissionProfile {
  return admissionProfile({
    owner: material.ref.owner,
    sourceKinds: ["delegation_result"],
    audiences: ["model", "runtime"],
    retention: ["history"],
    instructionRoles: ["data"],
    necessities: ["mandatory"],
    maximumPrecedence: 80,
  });
}

export function measureDelegationInitialContextBytes(input: {
  readonly rootPurpose: DelegationContextMaterial;
  readonly childTask: DelegationTaskPreparation;
  readonly predecessor: DelegationContextMaterial | null;
}): number {
  const rootPurpose = Object.freeze({
    kind: "structured" as const,
    value: input.rootPurpose.payload,
  });
  const childTask = Object.freeze({
    kind: "structured" as const,
    value: toContextJsonValue({
      kind: input.childTask.kind,
      input: input.childTask.input,
    }),
  });
  const predecessorBytes = input.predecessor === null
    ? 0
    : measureContextPayload(Object.freeze({
        kind: "structured" as const,
        value: input.predecessor.payload,
      })).payloadBytes;
  return measureContextPayload(rootPurpose).payloadBytes +
    measureContextPayload(childTask).payloadBytes + predecessorBytes;
}

export function createCurrentRunContextAdmissionProfile(): ContextAdmissionProfile {
  return admissionProfile({
    owner: "agent-runtime",
    sourceKinds: ["run_state", "run_plan"],
    audiences: ["model"],
    retention: ["current"],
    instructionRoles: ["data"],
    necessities: ["mandatory"],
    maximumPrecedence: 95,
  });
}

export function createObservationContextAdmissionProfile(
  owner: string,
): ContextAdmissionProfile {
  return admissionProfile({
    owner,
    sourceKinds: ["run_observation"],
    audiences: ["model", "product"],
    retention: ["history"],
    instructionRoles: ["data"],
    necessities: ["optional"],
    maximumPrecedence: 60,
  });
}

export function createSteeringContextAdmissionProfile(): ContextAdmissionProfile {
  return admissionProfile({
    owner: "run-steering",
    sourceKinds: ["steering_instruction"],
    audiences: ["model"],
    retention: ["history"],
    instructionRoles: ["user"],
    necessities: ["mandatory"],
    maximumPrecedence: 90,
  });
}

export function createProgressCorrectionContextAdmissionProfile(): ContextAdmissionProfile {
  return admissionProfile({
    owner: "agent-runtime",
    sourceKinds: ["run_progress_correction"],
    audiences: ["model"],
    retention: ["current"],
    instructionRoles: ["data"],
    necessities: ["mandatory"],
    maximumPrecedence: 92,
  });
}

export function createVerificationContextAdmissionProfile(): ContextAdmissionProfile {
  return admissionProfile({
    owner: "verification",
    sourceKinds: ["current_snapshot"],
    audiences: ["model"],
    retention: ["current"],
    instructionRoles: ["data"],
    necessities: ["optional"],
    maximumPrecedence: 0,
  });
}

function admissionProfile(input: {
  readonly owner: string;
  readonly sourceKinds: readonly string[];
  readonly audiences: readonly string[];
  readonly retention: readonly ("history" | "current")[];
  readonly instructionRoles: readonly ContextInstructionRole[];
  readonly necessities: readonly ("mandatory" | "optional")[];
  readonly maximumPrecedence: number;
}): ContextAdmissionProfile {
  return Object.freeze({
    ref: Object.freeze({ id: `${input.owner}:context-admission`, revision: "1" }),
    owner: input.owner,
    sourceKinds: Object.freeze([...input.sourceKinds]),
    disclosure: Object.freeze({
      sensitivity: "internal" as const,
      audiences: Object.freeze([...input.audiences]),
    }),
    retention: Object.freeze([...input.retention]),
    instructionRoles: Object.freeze([...input.instructionRoles]),
    necessities: Object.freeze([...input.necessities]),
    maximumPrecedence: input.maximumPrecedence,
    transformations: Object.freeze([
      "truncate" as const,
      "redact" as const,
      "reference" as const,
    ]),
  });
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): ContextJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH - 3)}...`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[Depth limit]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen)));
    const result: Record<string, ContextJsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_ENTRIES)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1, seen);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}
