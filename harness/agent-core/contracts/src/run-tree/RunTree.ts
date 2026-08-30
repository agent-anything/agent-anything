import type { RunRef } from "../run/index.js";
import type { RunActionRef } from "../run-action/index.js";

export interface DescendantRunRelationRef {
  readonly id: string;
}

export type DescendantRunRelationKind =
  | "delegation"
  | "replacement"
  | "continuation";

export interface RootRunLineage {
  readonly kind: "root";
  readonly root: RunRef;
  readonly depth: 0;
}

export interface DescendantRunLineage {
  readonly kind: "descendant";
  readonly root: RunRef;
  readonly parent: RunRef;
  readonly parentRunAction: RunActionRef;
  readonly relation: DescendantRunRelationRef;
  readonly depth: number;
}

export type RunLineage = RootRunLineage | DescendantRunLineage;

export interface DescendantRunRelation {
  readonly ref: DescendantRunRelationRef;
  readonly kind: DescendantRunRelationKind;
  readonly root: RunRef;
  readonly parent: RunRef;
  readonly child: RunRef;
  readonly parentRunAction: RunActionRef;
  readonly depth: number;
}

export interface CreateDescendantRunRelationInput {
  readonly relationId: string;
  readonly kind: DescendantRunRelationKind;
  readonly root: RunRef;
  readonly parent: RunRef;
  readonly child: RunRef;
  readonly parentRunAction: RunActionRef;
  readonly depth: number;
}

export function createRootRunLineage(root: RunRef): RootRunLineage {
  return Object.freeze({
    kind: "root" as const,
    root: snapshotRunRef(root, "root"),
    depth: 0 as const,
  });
}

export function createDescendantRunRelation(
  input: CreateDescendantRunRelationInput,
): DescendantRunRelation {
  const ref = snapshotRelationRef({ id: input.relationId });
  assertRelationKind(input.kind);
  const root = snapshotRunRef(input.root, "root");
  const parent = snapshotRunRef(input.parent, "parent");
  const child = snapshotRunRef(input.child, "child");
  const parentRunAction = snapshotRunActionRef(input.parentRunAction);
  assertPositiveInteger(input.depth, "depth");
  if (parent.id === child.id) {
    throw new TypeError("A descendant Run cannot be its own parent.");
  }
  if (root.id === child.id) {
    throw new TypeError("A descendant Run cannot replace the root Run.");
  }
  if (parentRunAction.run.id !== parent.id) {
    throw new TypeError("The creating RunAction must belong to the parent Run.");
  }
  return Object.freeze({
    ref,
    kind: input.kind,
    root,
    parent,
    child,
    parentRunAction,
    depth: input.depth,
  });
}

export function createDescendantRunLineage(
  relation: DescendantRunRelation,
): DescendantRunLineage {
  const snapshot = createDescendantRunRelation({
    relationId: relation.ref.id,
    kind: relation.kind,
    root: relation.root,
    parent: relation.parent,
    child: relation.child,
    parentRunAction: relation.parentRunAction,
    depth: relation.depth,
  });
  return Object.freeze({
    kind: "descendant" as const,
    root: snapshot.root,
    parent: snapshot.parent,
    parentRunAction: snapshot.parentRunAction,
    relation: snapshot.ref,
    depth: snapshot.depth,
  });
}

function assertRelationKind(
  value: unknown,
): asserts value is DescendantRunRelationKind {
  if (
    value !== "delegation" &&
    value !== "replacement" &&
    value !== "continuation"
  ) {
    throw new TypeError("Descendant relation kind is unsupported.");
  }
}

function snapshotRunRef(input: RunRef, field: string): RunRef {
  if (input === null || typeof input !== "object") {
    throw new TypeError(`${field} RunRef must be an object.`);
  }
  assertToken(input.id, `${field}.id`);
  return Object.freeze({ id: input.id });
}

function snapshotRelationRef(
  input: DescendantRunRelationRef,
): DescendantRunRelationRef {
  if (input === null || typeof input !== "object") {
    throw new TypeError("DescendantRunRelationRef must be an object.");
  }
  assertToken(input.id, "relation.id");
  return Object.freeze({ id: input.id });
}

function snapshotRunActionRef(input: RunActionRef): RunActionRef {
  if (input === null || typeof input !== "object") {
    throw new TypeError("parentRunAction must be a RunActionRef.");
  }
  const run = snapshotRunRef(input.run, "parentRunAction.run");
  assertToken(input.id, "parentRunAction.id");
  assertPositiveInteger(input.sequence, "parentRunAction.sequence");
  return Object.freeze({ run, id: input.id, sequence: input.sequence });
}

function assertToken(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty canonical string.`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
}
