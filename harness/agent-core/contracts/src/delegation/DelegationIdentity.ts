import type { AgentRevisionRef } from "../agent/index.js";
import type { RunRef } from "../run/index.js";
import type { RunActionRef } from "../run-action/index.js";
import type {
  DescendantRunRelation,
  DescendantRunRelationRef,
  RunLineage,
} from "../run-tree/index.js";
import { snapshotTaskRef, type TaskRef } from "../task/index.js";

export interface DelegationRequestRef {
  readonly id: string;
  readonly revision: string;
}

export interface DelegationResultRef {
  readonly id: string;
  readonly revision: string;
}

export interface DescendantContinuationRef {
  readonly id: string;
  readonly revision: string;
}

export interface DescendantContinuationCorrelation {
  readonly ref: DescendantContinuationRef;
  readonly sourceRequest: DelegationRequestRef;
  readonly sourceResult: DelegationResultRef;
  readonly root: RunRef;
  readonly parent: RunRef;
  readonly sourceChild: RunRef;
  readonly agent: AgentRevisionRef;
}

export interface DelegationOriginCorrelation {
  readonly root: {
    readonly run: RunRef;
    readonly task: TaskRef;
  };
  readonly parent: {
    readonly run: RunRef;
    readonly task: TaskRef;
    readonly action: RunActionRef;
    readonly lineage: RunLineage;
  };
}

export interface DelegationRunCorrelation {
  readonly request: DelegationRequestRef;
  readonly origin: DelegationOriginCorrelation;
  readonly relation: DescendantRunRelation;
  readonly child: {
    readonly run: RunRef;
    readonly task: TaskRef;
    readonly agent: AgentRevisionRef;
  };
}

export type DelegationSourceResultKind = "dependency" | "replacement";

export interface DelegationSourceResultCorrelation {
  readonly kind: DelegationSourceResultKind;
  readonly request: DelegationRequestRef;
  readonly result: DelegationResultRef;
  readonly root: RunRef;
  readonly child: {
    readonly run: RunRef;
    readonly task: TaskRef;
    readonly agent: AgentRevisionRef;
  };
}

export function snapshotDelegationRequestRef(
  input: DelegationRequestRef,
): DelegationRequestRef {
  strictRecord(input, "DelegationRequestRef", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "DelegationRequestRef.id"),
    revision: token(input.revision, "DelegationRequestRef.revision"),
  });
}

export function snapshotDelegationResultRef(
  input: DelegationResultRef,
): DelegationResultRef {
  strictRecord(input, "DelegationResultRef", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "DelegationResultRef.id"),
    revision: token(input.revision, "DelegationResultRef.revision"),
  });
}

export function snapshotDescendantContinuationRef(
  input: DescendantContinuationRef,
): DescendantContinuationRef {
  strictRecord(input, "DescendantContinuationRef", ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, "DescendantContinuationRef.id"),
    revision: token(input.revision, "DescendantContinuationRef.revision"),
  });
}

export function snapshotDescendantContinuationCorrelation(
  input: DescendantContinuationCorrelation,
): DescendantContinuationCorrelation {
  strictRecord(input, "DescendantContinuationCorrelation", [
    "ref",
    "sourceRequest",
    "sourceResult",
    "root",
    "parent",
    "sourceChild",
    "agent",
  ]);
  const correlation = deepFreeze({
    ref: snapshotDescendantContinuationRef(input.ref),
    sourceRequest: snapshotDelegationRequestRef(input.sourceRequest),
    sourceResult: snapshotDelegationResultRef(input.sourceResult),
    root: snapshotRunRef(input.root, "root"),
    parent: snapshotRunRef(input.parent, "parent"),
    sourceChild: snapshotRunRef(input.sourceChild, "sourceChild"),
    agent: snapshotAgentRef(input.agent, "agent"),
  });
  if (
    correlation.root.id === correlation.sourceChild.id ||
    correlation.parent.id === correlation.sourceChild.id
  ) {
    throw new TypeError("Continuation source child must be distinct from root and parent.");
  }
  return correlation;
}

export function snapshotDelegationOriginCorrelation(
  input: DelegationOriginCorrelation,
): DelegationOriginCorrelation {
  strictRecord(input, "DelegationOriginCorrelation", ["root", "parent"]);
  strictRecord(input.root, "DelegationOriginCorrelation.root", ["run", "task"]);
  strictRecord(input.parent, "DelegationOriginCorrelation.parent", [
    "run",
    "task",
    "action",
    "lineage",
  ]);
  const rootRun = snapshotRunRef(input.root.run, "root.run");
  const rootTask = snapshotTaskRef(input.root.task, "root.task");
  const parentRun = snapshotRunRef(input.parent.run, "parent.run");
  const parentTask = snapshotTaskRef(input.parent.task, "parent.task");
  const parentAction = snapshotRunActionRef(input.parent.action, "parent.action");
  const lineage = snapshotLineage(input.parent.lineage);

  if (parentAction.run.id !== parentRun.id) {
    throw new TypeError("Delegation parent RunAction must belong to the parent Run.");
  }
  if (lineage.root.id !== rootRun.id) {
    throw new TypeError("Delegation parent lineage must preserve the root Run.");
  }
  if (lineage.kind === "root") {
    if (parentRun.id !== rootRun.id || parentTask.id !== rootTask.id) {
      throw new TypeError("A root delegation parent must use the root Run and Task.");
    }
  } else if (parentRun.id === rootRun.id) {
    throw new TypeError("A descendant parent cannot identify itself as the root Run.");
  }

  return deepFreeze({
    root: { run: rootRun, task: rootTask },
    parent: {
      run: parentRun,
      task: parentTask,
      action: parentAction,
      lineage,
    },
  });
}

export function snapshotDelegationRunCorrelation(
  input: DelegationRunCorrelation,
): DelegationRunCorrelation {
  strictRecord(input, "DelegationRunCorrelation", [
    "request",
    "origin",
    "relation",
    "child",
  ]);
  strictRecord(input.child, "DelegationRunCorrelation.child", [
    "run",
    "task",
    "agent",
  ]);
  const request = snapshotDelegationRequestRef(input.request);
  const origin = snapshotDelegationOriginCorrelation(input.origin);
  const relation = snapshotRelation(input.relation);
  const child = {
    run: snapshotRunRef(input.child.run, "child.run"),
    task: snapshotTaskRef(input.child.task, "child.task"),
    agent: snapshotAgentRef(input.child.agent, "child.agent"),
  };

  if (
    relation.root.id !== origin.root.run.id ||
    relation.parent.id !== origin.parent.run.id ||
    relation.parentRunAction.id !== origin.parent.action.id ||
    relation.parentRunAction.sequence !== origin.parent.action.sequence
  ) {
    throw new TypeError("Delegation relation does not match its origin correlation.");
  }
  if (relation.child.id !== child.run.id) {
    throw new TypeError("Delegation relation does not match the child Run.");
  }

  return deepFreeze({ request, origin, relation, child });
}

export function snapshotDelegationSourceResultCorrelation(
  input: DelegationSourceResultCorrelation,
): DelegationSourceResultCorrelation {
  strictRecord(input, "DelegationSourceResultCorrelation", [
    "kind",
    "request",
    "result",
    "root",
    "child",
  ]);
  if (input.kind !== "dependency" && input.kind !== "replacement") {
    throw new TypeError("Delegation source-result kind is unsupported.");
  }
  strictRecord(input.child, "DelegationSourceResultCorrelation.child", [
    "run",
    "task",
    "agent",
  ]);
  return deepFreeze({
    kind: input.kind,
    request: snapshotDelegationRequestRef(input.request),
    result: snapshotDelegationResultRef(input.result),
    root: snapshotRunRef(input.root, "root"),
    child: {
      run: snapshotRunRef(input.child.run, "child.run"),
      task: snapshotTaskRef(input.child.task, "child.task"),
      agent: snapshotAgentRef(input.child.agent, "child.agent"),
    },
  });
}

function snapshotRelation(input: DescendantRunRelation): DescendantRunRelation {
  strictRecord(input, "DescendantRunRelation", [
    "ref",
    "kind",
    "root",
    "parent",
    "child",
    "parentRunAction",
    "depth",
  ]);
  strictRecord(input.ref, "DescendantRunRelation.ref", ["id"]);
  const relation: DescendantRunRelation = {
    ref: snapshotRelationRef(input.ref),
    kind: snapshotRelationKind(input.kind),
    root: snapshotRunRef(input.root, "relation.root"),
    parent: snapshotRunRef(input.parent, "relation.parent"),
    child: snapshotRunRef(input.child, "relation.child"),
    parentRunAction: snapshotRunActionRef(
      input.parentRunAction,
      "relation.parentRunAction",
    ),
    depth: positiveInteger(input.depth, "relation.depth"),
  };
  if (relation.parent.id === relation.child.id || relation.root.id === relation.child.id) {
    throw new TypeError("Delegation relation child must be distinct from root and parent.");
  }
  if (relation.parentRunAction.run.id !== relation.parent.id) {
    throw new TypeError("Delegation relation RunAction must belong to its parent Run.");
  }
  return deepFreeze(relation);
}

function snapshotRelationKind(
  input: unknown,
): DescendantRunRelation["kind"] {
  if (
    input !== "delegation" &&
    input !== "replacement" &&
    input !== "continuation"
  ) {
    throw new TypeError("Delegation relation kind is unsupported.");
  }
  return input;
}

function snapshotLineage(input: RunLineage): RunLineage {
  if (input.kind === "root") {
    strictRecord(input, "RunLineage", ["kind", "root", "depth"]);
    if (input.depth !== 0) throw new TypeError("Root Run lineage depth must be zero.");
    return deepFreeze({
      kind: "root" as const,
      root: snapshotRunRef(input.root, "lineage.root"),
      depth: 0 as const,
    });
  }
  if (input.kind !== "descendant") {
    throw new TypeError("RunLineage.kind is unsupported.");
  }
  strictRecord(input, "RunLineage", [
    "kind",
    "root",
    "parent",
    "parentRunAction",
    "relation",
    "depth",
  ]);
  strictRecord(input.relation, "RunLineage.relation", ["id"]);
  const parent = snapshotRunRef(input.parent, "lineage.parent");
  const parentRunAction = snapshotRunActionRef(
    input.parentRunAction,
    "lineage.parentRunAction",
  );
  if (parentRunAction.run.id !== parent.id) {
    throw new TypeError("Descendant lineage RunAction must belong to its parent Run.");
  }
  return deepFreeze({
    kind: "descendant" as const,
    root: snapshotRunRef(input.root, "lineage.root"),
    parent,
    parentRunAction,
    relation: snapshotRelationRef(input.relation),
    depth: positiveInteger(input.depth, "lineage.depth"),
  });
}

function snapshotRunRef(input: RunRef, field: string): RunRef {
  strictRecord(input, field, ["id"]);
  return Object.freeze({ id: token(input.id, `${field}.id`) });
}

function snapshotRunActionRef(input: RunActionRef, field: string): RunActionRef {
  strictRecord(input, field, ["run", "id", "sequence"]);
  return Object.freeze({
    run: snapshotRunRef(input.run, `${field}.run`),
    id: token(input.id, `${field}.id`),
    sequence: positiveInteger(input.sequence, `${field}.sequence`),
  });
}

function snapshotRelationRef(
  input: DescendantRunRelationRef,
): DescendantRunRelationRef {
  return Object.freeze({ id: token(input.id, "relation.id") });
}

function snapshotAgentRef(
  input: AgentRevisionRef,
  field: string,
): AgentRevisionRef {
  strictRecord(input, field, ["id", "revision"]);
  return Object.freeze({
    id: token(input.id, `${field}.id`),
    revision: token(input.revision, `${field}.revision`),
  });
}

function strictRecord(
  input: unknown,
  field: string,
  keys: readonly string[],
): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} must be an object.`);
  }
  const unsupported = Object.keys(input).find((key) => !keys.includes(key));
  if (unsupported !== undefined) {
    throw new TypeError(`${field} contains unsupported field '${unsupported}'.`);
  }
}

function token(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim()
  ) {
    throw new TypeError(`${field} must be a non-empty canonical string.`);
  }
  return input;
}

function positiveInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return input as number;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) {
      deepFreeze(value);
    }
    Object.freeze(input);
  }
  return input;
}
