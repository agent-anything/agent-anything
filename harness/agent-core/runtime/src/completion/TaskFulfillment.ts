import type {
  ControllerTurnRef,
  InvocationCancellationRef,
  InvocationInterruptionContext,
} from "@agent-anything/agent-core/control";
import type { RunRef } from "@agent-anything/agent-core/run";
import {
  snapshotAgentTask,
  type AgentTask,
} from "@agent-anything/agent-core/task";
import type { CompletionProposalRef } from "@agent-anything/verification/completion";
import type {
  ControllerVerificationProjection,
  ModelInteractionProjection,
} from "../controller/Controller.js";

const MAX_FINDINGS = 32;
const MAX_TEXT_LENGTH = 8_192;

export interface TaskObjectiveRef {
  readonly id: string;
  readonly kind: string;
  readonly revision: string;
}

export interface TaskFulfillmentEvaluatorRef {
  readonly owner: string;
  readonly id: string;
  readonly revision: string;
}

export interface TaskFulfillmentAssessmentRef {
  readonly id: string;
  readonly revision: string;
}

export type TaskFulfillmentStatus = "fulfilled" | "incomplete" | "uncertain";

export type TaskFulfillmentFindingKind =
  | "missing_outcome"
  | "objective_mismatch"
  | "unsupported_claim"
  | "uncertainty";

export interface TaskFulfillmentFinding {
  readonly kind: TaskFulfillmentFindingKind;
  readonly code: string;
  readonly message: string;
}

export interface TaskFulfillmentEvaluationInput<TOutput = unknown> {
  readonly assessment: TaskFulfillmentAssessmentRef;
  readonly run: RunRef;
  readonly turn: ControllerTurnRef;
  readonly objective: TaskObjectiveRef;
  readonly task: AgentTask;
  readonly proposal: CompletionProposalRef;
  readonly output: TOutput;
  readonly interaction: ModelInteractionProjection;
  readonly verification: ControllerVerificationProjection;
  readonly requestedAt: string;
  readonly deadlineAt: string;
}

export interface TaskFulfillmentAssessment {
  readonly ref: TaskFulfillmentAssessmentRef;
  readonly evaluator: TaskFulfillmentEvaluatorRef;
  readonly run: RunRef;
  readonly turn: ControllerTurnRef;
  readonly objective: TaskObjectiveRef;
  readonly proposal: CompletionProposalRef;
  readonly status: TaskFulfillmentStatus;
  readonly rationale: string;
  readonly findings: readonly TaskFulfillmentFinding[];
  readonly feedback: string | null;
  readonly assessedAt: string;
}

export interface TaskFulfillmentFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type TaskFulfillmentEvaluationResult =
  | {
      readonly kind: "assessed";
      readonly assessment: TaskFulfillmentAssessment;
    }
  | {
      readonly kind: "failed";
      readonly failure: TaskFulfillmentFailure;
    }
  | {
      readonly kind: "cancelled";
      readonly cancellation: InvocationCancellationRef;
    };

export interface TaskFulfillmentEvaluatorPort {
  readonly ref: TaskFulfillmentEvaluatorRef;
  evaluate(
    input: TaskFulfillmentEvaluationInput,
    interruption: InvocationInterruptionContext,
  ): Promise<TaskFulfillmentEvaluationResult>;
}

export function snapshotTaskFulfillmentEvaluationInput<TOutput>(
  input: TaskFulfillmentEvaluationInput<TOutput>,
): TaskFulfillmentEvaluationInput<TOutput> {
  record(input, "TaskFulfillmentEvaluationInput", [
    "assessment", "run", "turn", "objective", "task", "proposal", "output",
    "interaction", "verification", "requestedAt", "deadlineAt",
  ]);
  const run = runRef(input.run, "TaskFulfillmentEvaluationInput.run");
  const turn = turnRef(input.turn, "TaskFulfillmentEvaluationInput.turn");
  const objective = objectiveRef(input.objective, "TaskFulfillmentEvaluationInput.objective");
  const task = snapshotAgentTask(input.task);
  if (turn.run.id !== run.id) {
    throw new TypeError("Task Fulfillment Run and Controller turn must match.");
  }
  if (task.id !== objective.id || task.kind !== objective.kind) {
    throw new TypeError("Task Fulfillment objective must identify the accepted Task.");
  }
  if (input.verification.snapshot.runId !== run.id) {
    throw new TypeError("Task Fulfillment Verification projection must match the Run.");
  }
  const requestedAt = iso(input.requestedAt, "TaskFulfillmentEvaluationInput.requestedAt");
  const deadlineAt = iso(input.deadlineAt, "TaskFulfillmentEvaluationInput.deadlineAt");
  if (Date.parse(deadlineAt) < Date.parse(requestedAt)) {
    throw new TypeError("Task Fulfillment deadline cannot precede its request time.");
  }
  return deepFreeze({
    assessment: revisionRef(input.assessment, "TaskFulfillmentEvaluationInput.assessment"),
    run,
    turn,
    objective,
    task,
    proposal: revisionRef(input.proposal, "TaskFulfillmentEvaluationInput.proposal"),
    output: clone(input.output),
    interaction: clone(input.interaction),
    verification: clone(input.verification),
    requestedAt,
    deadlineAt,
  });
}

export function snapshotTaskFulfillmentAssessment(
  input: TaskFulfillmentAssessment,
): TaskFulfillmentAssessment {
  record(input, "TaskFulfillmentAssessment", [
    "ref", "evaluator", "run", "turn", "objective", "proposal", "status",
    "rationale", "findings", "feedback", "assessedAt",
  ]);
  if (!["fulfilled", "incomplete", "uncertain"].includes(input.status)) {
    throw new TypeError("TaskFulfillmentAssessment.status is unsupported.");
  }
  if (!Array.isArray(input.findings) || input.findings.length > MAX_FINDINGS) {
    throw new TypeError("TaskFulfillmentAssessment.findings must be bounded.");
  }
  const run = runRef(input.run, "TaskFulfillmentAssessment.run");
  const turn = turnRef(input.turn, "TaskFulfillmentAssessment.turn");
  if (turn.run.id !== run.id) {
    throw new TypeError("Task Fulfillment Assessment Run and turn must match.");
  }
  const feedback = input.feedback === null
    ? null
    : text(input.feedback, "TaskFulfillmentAssessment.feedback");
  if (input.status === "fulfilled" && feedback !== null) {
    throw new TypeError("A fulfilled Task assessment cannot carry continuation feedback.");
  }
  if (input.status === "fulfilled" && input.findings.length > 0) {
    throw new TypeError("A fulfilled Task assessment cannot carry unresolved findings.");
  }
  if (input.status !== "fulfilled" && feedback === null) {
    throw new TypeError("A non-fulfilled Task assessment requires continuation feedback.");
  }
  return deepFreeze({
    ref: revisionRef(input.ref, "TaskFulfillmentAssessment.ref"),
    evaluator: evaluatorRef(input.evaluator, "TaskFulfillmentAssessment.evaluator"),
    run,
    turn,
    objective: objectiveRef(input.objective, "TaskFulfillmentAssessment.objective"),
    proposal: revisionRef(input.proposal, "TaskFulfillmentAssessment.proposal"),
    status: input.status,
    rationale: text(input.rationale, "TaskFulfillmentAssessment.rationale"),
    findings: input.findings.map((finding, index) =>
      snapshotFinding(finding, `TaskFulfillmentAssessment.findings[${index}]`)),
    feedback,
    assessedAt: iso(input.assessedAt, "TaskFulfillmentAssessment.assessedAt"),
  });
}

export function createTaskFulfillmentFailure(input: TaskFulfillmentFailure): TaskFulfillmentFailure {
  record(input, "TaskFulfillmentFailure", ["code", "message", "retryable", "metadata"]);
  if (typeof input.retryable !== "boolean") {
    throw new TypeError("TaskFulfillmentFailure.retryable must be boolean.");
  }
  if (input.metadata === null || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
    throw new TypeError("TaskFulfillmentFailure.metadata must be a record.");
  }
  return deepFreeze({
    code: token(input.code, "TaskFulfillmentFailure.code"),
    message: text(input.message, "TaskFulfillmentFailure.message"),
    retryable: input.retryable,
    metadata: clone(input.metadata),
  });
}

function snapshotFinding(input: TaskFulfillmentFinding, path: string): TaskFulfillmentFinding {
  record(input, path, ["kind", "code", "message"]);
  if (!["missing_outcome", "objective_mismatch", "unsupported_claim", "uncertainty"].includes(input.kind)) {
    throw new TypeError(`${path}.kind is unsupported.`);
  }
  return Object.freeze({
    kind: input.kind,
    code: token(input.code, `${path}.code`),
    message: text(input.message, `${path}.message`),
  });
}

function objectiveRef(input: TaskObjectiveRef, path: string): TaskObjectiveRef {
  record(input, path, ["id", "kind", "revision"]);
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    kind: token(input.kind, `${path}.kind`),
    revision: token(input.revision, `${path}.revision`),
  });
}

export function snapshotTaskFulfillmentEvaluatorRef(
  input: TaskFulfillmentEvaluatorRef,
  path = "TaskFulfillmentEvaluatorRef",
): TaskFulfillmentEvaluatorRef {
  record(input, path, ["owner", "id", "revision"]);
  return Object.freeze({
    owner: token(input.owner, `${path}.owner`),
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  });
}

const evaluatorRef = snapshotTaskFulfillmentEvaluatorRef;

function runRef(input: RunRef, path: string): RunRef {
  record(input, path, ["id"]);
  return Object.freeze({ id: token(input.id, `${path}.id`) });
}

function turnRef(input: ControllerTurnRef, path: string): ControllerTurnRef {
  record(input, path, ["run", "id", "sequence"]);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError(`${path}.sequence must be a positive safe integer.`);
  }
  return Object.freeze({
    run: runRef(input.run, `${path}.run`),
    id: token(input.id, `${path}.id`),
    sequence: input.sequence,
  });
}

function revisionRef<T extends { readonly id: string; readonly revision: string }>(input: T, path: string): T {
  record(input, path, ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
  }) as T;
}

function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || /\s/u.test(input)) {
    throw new TypeError(`${path} must be a canonical token.`);
  }
  return input;
}

function text(input: unknown, path: string): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${path} must be bounded non-empty text.`);
  }
  return input;
}

function iso(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) {
    throw new TypeError(`${path} must be an ISO date-time.`);
  }
  return input;
}

function record(input: unknown, path: string, keys: readonly string[]): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${path} must be a record.`);
  }
  const unknown = Object.keys(input).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unsupported field '${unknown[0]}'.`);
}

function clone<T>(input: T): T {
  if (Array.isArray(input)) return input.map((item) => clone(item)) as T;
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, clone(value)])) as T;
  }
  return input;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
