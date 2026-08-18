import type {
  ControllerTurnRef,
  InvocationInterruptionContext,
} from "@agent-anything/agent-core/control";
import type { RunRef } from "@agent-anything/agent-core/run";
import {
  createValidationFailure,
  type ValidationCompletionDisposition,
  type ValidationFailure,
  type ValidationOwnerRef,
  type ValidationRequirementRef,
  type ValidationSpecificationRef,
} from "../definition/index.js";
import {
  snapshotValidationCurrentRequirementState,
  type ValidationCurrentRequirementState,
  type ValidationCurrentSnapshotRef,
} from "../assessment/index.js";
export type CompletionGateDecisionStatus =
  | "completion_eligible"
  | "blocked_unassessed"
  | "blocked_pending"
  | "blocked_stale"
  | "blocked_violated"
  | "blocked_inconclusive"
  | "invalid"
  | "failed";

export interface CompletionProposalRef {
  readonly id: string;
  readonly revision: string;
}

export interface CompletionGateInvocationRef {
  readonly id: string;
  readonly revision: string;
}

export interface CompletionGatePolicyRef extends ValidationOwnerRef {}

export interface CompletionGateConditionRef extends ValidationOwnerRef {
  readonly required: boolean;
  readonly satisfied: boolean;
}

export interface CompletionGateConfiguration {
  readonly policy: CompletionGatePolicyRef;
  readonly outputContract: ValidationOwnerRef;
  readonly conditions: readonly CompletionGateConditionRef[];
  readonly maximumDurationMs: number;
}

export interface CompletionGateLifecycleBasis {
  readonly runRevision: number;
  readonly status: "running" | "waiting";
  readonly cancellationRevision: number;
  readonly deadlineAt: string | null;
}

export interface CompletionGateRequirementState {
  readonly current: ValidationCurrentRequirementState;
  readonly disposition: ValidationCompletionDisposition | null;
}

export interface CompletionGateInput {
  readonly invocation: CompletionGateInvocationRef;
  readonly run: RunRef;
  readonly turn: ControllerTurnRef;
  readonly proposal: CompletionProposalRef;
  readonly proposalOutputDigest: string;
  readonly outputContract: ValidationOwnerRef;
  readonly specification: ValidationSpecificationRef | null;
  readonly validationSnapshot: ValidationCurrentSnapshotRef;
  readonly mandatoryStates: readonly CompletionGateRequirementState[];
  readonly pendingWork: readonly ValidationOwnerRef[];
  readonly conditions: readonly CompletionGateConditionRef[];
  readonly lifecycle: CompletionGateLifecycleBasis;
  readonly policy: CompletionGatePolicyRef;
  readonly correlation: ValidationOwnerRef;
  readonly requestedAt: string;
}

export interface CompletionGateReason {
  readonly owner: string;
  readonly code: string;
  readonly message: string;
  readonly requirement: ValidationRequirementRef | null;
}

interface CompletionGateDecisionBase {
  readonly invocation: CompletionGateInvocationRef;
  readonly validationSnapshot: ValidationCurrentSnapshotRef;
  readonly decidedAt: string;
}

export type CompletionGateDecision =
  | (CompletionGateDecisionBase & {
      readonly status: "completion_eligible";
      readonly disposition: null;
      readonly reasons: readonly [];
      readonly failure: null;
    })
  | (CompletionGateDecisionBase & {
      readonly status:
        | "blocked_unassessed"
        | "blocked_pending"
        | "blocked_stale"
        | "blocked_violated"
        | "blocked_inconclusive";
      readonly disposition: ValidationCompletionDisposition;
      readonly reasons: readonly [CompletionGateReason, ...CompletionGateReason[]];
      readonly failure: null;
    })
  | (CompletionGateDecisionBase & {
      readonly status: "invalid" | "failed";
      readonly disposition: ValidationCompletionDisposition;
      readonly reasons: readonly CompletionGateReason[];
      readonly failure: ValidationFailure;
    });

export interface CompletionGateRecord {
  readonly ref: CompletionGateInvocationRef;
  readonly inputRevision: string;
  readonly decision: CompletionGateDecision;
}

export interface CompletionGatePort {
  evaluate(
    input: CompletionGateInput,
    interruption: InvocationInterruptionContext,
  ): Promise<CompletionGateDecision>;
}

export function snapshotCompletionGateConfiguration(
  input: CompletionGateConfiguration,
): CompletionGateConfiguration {
  strictRecord(input, "CompletionGateConfiguration", [
    "policy", "outputContract", "conditions", "maximumDurationMs",
  ]);
  return deepFreeze({
    policy: ownerRef(input.policy, "CompletionGateConfiguration.policy"),
    outputContract: ownerRef(input.outputContract, "CompletionGateConfiguration.outputContract"),
    conditions: unique(input.conditions.map((condition, index) => {
      const path = `CompletionGateConfiguration.conditions[${index}]`;
      strictRecord(condition, path, ["owner", "kind", "id", "revision", "required", "satisfied"]);
      if (typeof condition.required !== "boolean" || typeof condition.satisfied !== "boolean") {
        throw new TypeError(`${path} flags must be boolean.`);
      }
      return { ...ownerRefFields(condition, path), required: condition.required, satisfied: condition.satisfied };
    }), ownerKey, "CompletionGateConfiguration.conditions"),
    maximumDurationMs: positiveInteger(input.maximumDurationMs, "CompletionGateConfiguration.maximumDurationMs"),
  });
}

export function snapshotCompletionGateInput(input: CompletionGateInput): CompletionGateInput {
  strictRecord(input, "CompletionGateInput", [
    "invocation", "run", "turn", "proposal", "proposalOutputDigest", "outputContract",
    "specification", "validationSnapshot", "mandatoryStates", "pendingWork", "conditions",
    "lifecycle", "policy", "correlation", "requestedAt",
  ]);
  strictRecord(input.run, "CompletionGateInput.run", ["id"]);
  strictRecord(input.turn, "CompletionGateInput.turn", ["run", "id", "sequence"]);
  strictRecord(input.lifecycle, "CompletionGateInput.lifecycle", [
    "runRevision", "status", "cancellationRevision", "deadlineAt",
  ]);
  const runId = token(input.run.id, "CompletionGateInput.run.id");
  if (input.turn.run.id !== runId || input.validationSnapshot.runId !== runId) {
    throw new TypeError("CompletionGateInput Run, turn, and Validation snapshot must match.");
  }
  if (input.lifecycle.status !== "running" && input.lifecycle.status !== "waiting") {
    throw new TypeError("CompletionGateInput.lifecycle.status is unsupported.");
  }
  return deepFreeze(clone({
    ...input,
    invocation: revisionRef(input.invocation, "CompletionGateInput.invocation"),
    run: { id: runId },
    turn: {
      run: { id: runId },
      id: token(input.turn.id, "CompletionGateInput.turn.id"),
      sequence: positiveInteger(input.turn.sequence, "CompletionGateInput.turn.sequence"),
    },
    proposal: revisionRef(input.proposal, "CompletionGateInput.proposal"),
    proposalOutputDigest: token(input.proposalOutputDigest, "CompletionGateInput.proposalOutputDigest"),
    outputContract: ownerRef(input.outputContract, "CompletionGateInput.outputContract"),
    specification: input.specification === null ? null : revisionRef(input.specification, "CompletionGateInput.specification"),
    validationSnapshot: snapshotRef(input.validationSnapshot, "CompletionGateInput.validationSnapshot"),
    mandatoryStates: unique(input.mandatoryStates.map((item, index) => {
      strictRecord(item, `CompletionGateInput.mandatoryStates[${index}]`, ["current", "disposition"]);
      if (item.current.status === "satisfied") {
        if (item.disposition !== null) {
          throw new TypeError(`CompletionGateInput.mandatoryStates[${index}].disposition must be null for satisfied state.`);
        }
      } else {
        disposition(item.disposition, `CompletionGateInput.mandatoryStates[${index}].disposition`);
      }
      return {
        current: snapshotValidationCurrentRequirementState(item.current),
        disposition: item.disposition,
      };
    }),
      (item) => `${item.current.requirement.id}@${item.current.requirement.revision}`,
      "CompletionGateInput.mandatoryStates"),
    pendingWork: unique(input.pendingWork.map((item, index) => ownerRef(item, `CompletionGateInput.pendingWork[${index}]`)),
      ownerKey, "CompletionGateInput.pendingWork"),
    conditions: unique(input.conditions.map((condition, index) => {
      strictRecord(condition, `CompletionGateInput.conditions[${index}]`, [
        "owner", "kind", "id", "revision", "required", "satisfied",
      ]);
      if (typeof condition.required !== "boolean" || typeof condition.satisfied !== "boolean") {
        throw new TypeError("CompletionGateInput condition flags must be boolean.");
      }
      return { ...ownerRefFields(condition, `CompletionGateInput.conditions[${index}]`),
        required: condition.required, satisfied: condition.satisfied };
    }), ownerKey, "CompletionGateInput.conditions"),
    lifecycle: {
      ...input.lifecycle,
      runRevision: nonNegativeInteger(input.lifecycle.runRevision, "CompletionGateInput.lifecycle.runRevision"),
      cancellationRevision: nonNegativeInteger(input.lifecycle.cancellationRevision, "CompletionGateInput.lifecycle.cancellationRevision"),
      deadlineAt: input.lifecycle.deadlineAt === null ? null : isoDateTime(input.lifecycle.deadlineAt, "CompletionGateInput.lifecycle.deadlineAt"),
    },
    policy: ownerRef(input.policy, "CompletionGateInput.policy"),
    correlation: ownerRef(input.correlation, "CompletionGateInput.correlation"),
    requestedAt: isoDateTime(input.requestedAt, "CompletionGateInput.requestedAt"),
  })) as CompletionGateInput;
}

export function snapshotCompletionGateDecision(
  input: CompletionGateDecision,
): CompletionGateDecision {
  strictRecord(input, "CompletionGateDecision", [
    "invocation", "validationSnapshot", "status", "disposition", "reasons", "failure", "decidedAt",
  ]);
  if (!GATE_STATUSES.includes(input.status)) throw new TypeError("CompletionGateDecision.status is unsupported.");
  const reasons = input.reasons.map((reason, index) => snapshotReason(reason, `CompletionGateDecision.reasons[${index}]`));
  if (input.status === "completion_eligible") {
    if (input.disposition !== null || input.failure !== null || reasons.length !== 0) {
      throw new TypeError("An eligible Completion Gate decision cannot carry disposition, reasons, or Failure.");
    }
  } else if (input.status === "invalid" || input.status === "failed") {
    if (input.failure === null) throw new TypeError(`${input.status} Completion Gate decision requires ValidationFailure.`);
    disposition(input.disposition, "CompletionGateDecision.disposition");
  } else {
    if (input.failure !== null || reasons.length === 0) {
      throw new TypeError("A blocked Completion Gate decision requires reasons and cannot carry Failure.");
    }
    disposition(input.disposition, "CompletionGateDecision.disposition");
  }
  return deepFreeze(clone({
    ...input,
    invocation: revisionRef(input.invocation, "CompletionGateDecision.invocation"),
    validationSnapshot: snapshotRef(input.validationSnapshot, "CompletionGateDecision.validationSnapshot"),
    reasons,
    failure: input.failure === null ? null : createValidationFailure(input.failure),
    decidedAt: isoDateTime(input.decidedAt, "CompletionGateDecision.decidedAt"),
  })) as CompletionGateDecision;
}

const GATE_STATUSES: readonly CompletionGateDecisionStatus[] = [
  "completion_eligible", "blocked_unassessed", "blocked_pending", "blocked_stale",
  "blocked_violated", "blocked_inconclusive", "invalid", "failed",
];

function snapshotReason(input: CompletionGateReason, path: string): CompletionGateReason {
  strictRecord(input, path, ["owner", "code", "message", "requirement"]);
  return {
    owner: token(input.owner, `${path}.owner`),
    code: token(input.code, `${path}.code`),
    message: nonEmpty(input.message, `${path}.message`),
    requirement: input.requirement === null ? null : revisionRef(input.requirement, `${path}.requirement`),
  };
}
function ownerRef(input: ValidationOwnerRef, path: string): ValidationOwnerRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return ownerRefFields(input, path);
}
function ownerRefFields(input: ValidationOwnerRef, path: string): ValidationOwnerRef {
  return { owner: token(input.owner, `${path}.owner`), kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}
function ownerKey(input: ValidationOwnerRef): string { return `${input.owner}:${input.kind}:${input.id}@${input.revision}`; }
function revisionRef(input: { readonly id: string; readonly revision: string }, path: string) {
  strictRecord(input, path, ["id", "revision"]);
  return { id: token(input.id, `${path}.id`), revision: token(input.revision, `${path}.revision`) };
}
function snapshotRef(input: ValidationCurrentSnapshotRef, path: string): ValidationCurrentSnapshotRef {
  strictRecord(input, path, ["runId", "revision"]);
  return { runId: token(input.runId, `${path}.runId`), revision: nonNegativeInteger(input.revision, `${path}.revision`) };
}
function disposition(input: unknown, path: string): asserts input is ValidationCompletionDisposition {
  if (!["continue", "wait", "block", "fail"].includes(input as string)) throw new TypeError(`${path} is unsupported.`);
}
function strictRecord(input: unknown, path: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`${path} must be a record.`);
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unsupported field '${unknown[0]}'.`);
}
function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/.test(input)) throw new TypeError(`${path} must be a canonical token.`);
  return input;
}
function nonEmpty(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0) throw new TypeError(`${path} is required.`);
  return input;
}
function positiveInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) throw new TypeError(`${path} must be a positive integer.`);
  return input as number;
}
function nonNegativeInteger(input: unknown, path: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) throw new TypeError(`${path} must be non-negative.`);
  return input as number;
}
function isoDateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw new TypeError(`${path} must be an ISO date-time.`);
  return input;
}
function unique<T>(input: readonly T[], key: (item: T) => string, path: string): readonly T[] {
  const values = input.map(key);
  if (new Set(values).size !== values.length) throw new TypeError(`${path} must not contain duplicates.`);
  return [...input];
}
function clone<T>(input: T): T {
  if (Array.isArray(input)) return input.map((item) => clone(item)) as T;
  if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T;
  return input;
}
function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
