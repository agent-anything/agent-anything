import type { AgentRevisionRef } from "@agent-anything/agent-core/agent";
import type { ArtifactRef, RunRef } from "@agent-anything/agent-core/run";
import type { EvidenceRef } from "@agent-anything/context/evidence";
import type { RunItem } from "./RunItem.js";
import {
  snapshotRunSettlement,
  snapshotRunSettlementCauseRecord,
  type RunSettlement,
  type RunSettlementCauseRecord,
} from "./RunSettlement.js";
import {
  snapshotAgentInstructionBindingRef,
  type AgentInstructionBindingRef,
} from "../instructions/index.js";

interface RunResultBase<TOutput> {
  readonly run: RunRef;
  readonly runId: string;
  readonly taskId: string;
  readonly startingAgent: AgentRevisionRef;
  readonly finalActiveAgent: AgentRevisionRef;
  readonly startingInstructionBinding: AgentInstructionBindingRef;
  readonly finalInstructionBinding: AgentInstructionBindingRef;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly items: readonly RunItem<TOutput>[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly artifactRefs: readonly ArtifactRef[];
  readonly settlementCauses: readonly RunSettlementCauseRecord[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type SucceededRunResult<TOutput> = RunResultBase<TOutput> & {
  readonly status: "succeeded";
  readonly finalOutput: TOutput;
  readonly settlement: Extract<RunSettlement<TOutput>, { readonly status: "succeeded" }>;
  readonly cause: Extract<RunSettlementCauseRecord, { readonly kind: "completion" }>;
};

export type FailedRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "failed";
  readonly finalOutput: null;
  readonly settlement: Extract<RunSettlement<TOutput>, { readonly status: "failed" }>;
  readonly cause: Extract<RunSettlementCauseRecord, { readonly kind: "failure" }>;
};

export type CancelledRunResult<TOutput = never> = RunResultBase<TOutput> & {
  readonly status: "cancelled";
  readonly finalOutput: null;
  readonly settlement: Extract<RunSettlement<TOutput>, { readonly status: "cancelled" }>;
  readonly cause: Extract<RunSettlementCauseRecord, { readonly kind: "cancellation" }>;
};

export type RunResult<TOutput = unknown> =
  | SucceededRunResult<TOutput>
  | FailedRunResult<TOutput>
  | CancelledRunResult<TOutput>;

export interface CreateRunResultInput<TOutput = unknown> {
  readonly runId: string;
  readonly taskId: string;
  readonly startingAgent: AgentRevisionRef;
  readonly finalActiveAgent: AgentRevisionRef;
  readonly startingInstructionBinding: AgentInstructionBindingRef;
  readonly finalInstructionBinding: AgentInstructionBindingRef;
  readonly startedAt: string;
  readonly settlement: RunSettlement<TOutput>;
  readonly cause: RunSettlementCauseRecord;
  readonly settlementCauses: readonly RunSettlementCauseRecord[];
  readonly items?: readonly RunItem<TOutput>[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly artifactRefs?: readonly ArtifactRef[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function createRunResult<TOutput>(input: CreateRunResultInput<TOutput>): RunResult<TOutput> {
  const cause = snapshotRunSettlementCauseRecord(input.cause);
  const settlement = snapshotRunSettlement(input.settlement, cause);
  const common = base(input, settlement.completedAt);
  const settlementCauses = snapshotCauseRecords(input.settlementCauses, input.runId, cause);
  if (settlement.status === "succeeded" && cause.kind === "completion") {
    return deepFreeze({ ...common, status: "succeeded" as const, finalOutput: settlement.output, settlement, cause, settlementCauses });
  }
  if (settlement.status === "failed" && cause.kind === "failure") {
    return deepFreeze({ ...common, status: "failed" as const, finalOutput: null, settlement, cause, settlementCauses });
  }
  if (settlement.status === "cancelled" && cause.kind === "cancellation") {
    return deepFreeze({ ...common, status: "cancelled" as const, finalOutput: null, settlement, cause, settlementCauses });
  }
  throw new TypeError("RunResult settlement and cause disagree.");
}

function base<TOutput>(input: CreateRunResultInput<TOutput>, completedAt: string): Omit<RunResultBase<TOutput>, "settlementCauses"> {
  if (!isRecord(input)) throw new TypeError("RunResult input must be an object.");
  token(input.runId, "runId");
  token(input.taskId, "taskId");
  const startingAgent = snapshotAgentRef(input.startingAgent, "startingAgent");
  const finalActiveAgent = snapshotAgentRef(input.finalActiveAgent, "finalActiveAgent");
  const startingInstructionBinding = snapshotAgentInstructionBindingRef(input.startingInstructionBinding);
  const finalInstructionBinding = snapshotAgentInstructionBindingRef(input.finalInstructionBinding);
  const startedAtMs = dateTime(input.startedAt, "startedAt");
  const completedAtMs = dateTime(completedAt, "completedAt");
  if (completedAtMs < startedAtMs) throw new TypeError("RunResult cannot complete before it starts.");
  const items = snapshotItems(input.items ?? [], input.runId);
  const evidenceRefs = snapshotStringRefs(input.evidenceRefs ?? [], "evidenceRefs");
  const artifactRefs = snapshotStringRefs(input.artifactRefs ?? [], "artifactRefs");
  if (!isRecord(input.metadata ?? {})) throw new TypeError("metadata must be an object.");
  return {
    run: Object.freeze({ id: input.runId }),
    runId: input.runId,
    taskId: input.taskId,
    startingAgent,
    finalActiveAgent,
    startingInstructionBinding,
    finalInstructionBinding,
    startedAt: input.startedAt,
    completedAt,
    items,
    evidenceRefs,
    artifactRefs,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  };
}

function snapshotCauseRecords(values: readonly RunSettlementCauseRecord[], runId: string, direct: RunSettlementCauseRecord): readonly RunSettlementCauseRecord[] {
  if (!Array.isArray(values)) throw new TypeError("settlementCauses must be an array.");
  const seen = new Set<string>();
  const records = values.map((value) => {
    const record = snapshotRunSettlementCauseRecord(value);
    if (record.ref.run.id !== runId) throw new TypeError("Settlement cause belongs to another Run.");
    const key = `${record.ref.id}\0${record.ref.revision}`;
    if (seen.has(key)) throw new TypeError("Settlement causes contain duplicate refs.");
    seen.add(key);
    return record;
  });
  const directKey = `${direct.ref.id}\0${direct.ref.revision}`;
  if (!seen.has(directKey)) throw new TypeError("RunResult settlement cause is missing from settlementCauses.");
  return Object.freeze(records);
}

function snapshotAgentRef(value: AgentRevisionRef, field: string): AgentRevisionRef {
  if (!isRecord(value)) throw new TypeError(`${field} must be an Agent revision.`);
  token(value.id, `${field}.id`);
  token(value.revision, `${field}.revision`);
  return Object.freeze({ id: value.id, revision: value.revision });
}

function snapshotItems<TOutput>(values: readonly RunItem<TOutput>[], runId: string): readonly RunItem<TOutput>[] {
  if (!Array.isArray(values)) throw new TypeError("items must be an array.");
  let priorRevision = 0;
  return Object.freeze(values.map((item, index) => {
    const raw = item as unknown;
    if (!isRecord(raw) || !isRecord(raw.ref) || !isRecord(raw.ref.run)) {
      throw new TypeError(`items[${index}] must be a RunItem.`);
    }
    if (raw.ref.run.id !== runId) throw new TypeError(`RunItem does not belong to Run ${runId}.`);
    if (raw.ref.sequence !== index + 1) throw new TypeError("RunItem sequence must be contiguous.");
    if (!Number.isSafeInteger(raw.committedInRevision) || Number(raw.committedInRevision) < 1 || Number(raw.committedInRevision) < priorRevision) {
      throw new TypeError("RunItem committed revisions must be positive and non-decreasing.");
    }
    dateTime(raw.createdAt, `items[${index}].createdAt`);
    priorRevision = Number(raw.committedInRevision);
    return item;
  }));
}

function snapshotStringRefs<TRef extends string>(values: readonly TRef[], field: string): readonly TRef[] {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array.`);
  const seen = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    token(value, `${field}[${index}]`);
    if (seen.has(value)) throw new TypeError(`${field} contains duplicate '${value}'.`);
    seen.add(value);
    return value as TRef;
  }));
}

function dateTime(value: unknown, field: string): number {
  if (typeof value !== "string") throw new TypeError(`${field} must be a valid date-time string.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid date-time string.`);
  return parsed;
}

function token(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be non-empty.`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
