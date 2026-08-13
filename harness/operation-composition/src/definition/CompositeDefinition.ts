import type { OperationBindingKind } from "@agent-anything/operation-catalog/binding";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";

export interface CompositeDefinitionRef {
  readonly id: string;
  readonly revision: string;
}

export interface CompositeNodeDefinition {
  readonly id: string;
  readonly operation: OperationRevisionRef;
  readonly allowedBindings: readonly OperationBindingKind[];
  readonly dependencies: readonly string[];
  readonly transformId: string;
  readonly conditionId: string | null;
  readonly resourceClaims: readonly CompositeResourceClaim[];
  readonly required: boolean;
}

export interface CompositeResourceClaim {
  readonly family: string;
  readonly identity: string;
  readonly access: "observe" | "mutate" | "exclusive";
}

export type CompositeJoinPolicy =
  | { readonly kind: "all_required_succeeded" }
  | { readonly kind: "all_selected_settled" }
  | { readonly kind: "first_success" }
  | { readonly kind: "quorum"; readonly count: number };

export interface CompositeDefinitionRevision {
  readonly ref: CompositeDefinitionRef;
  readonly inputSchemaRevision: string;
  readonly resultSchemaRevision: string;
  readonly graphRevision: string;
  readonly nodes: readonly CompositeNodeDefinition[];
  readonly join: CompositeJoinPolicy;
  readonly reducerId: string;
  readonly conflictPolicyRevision: string;
  readonly limits: {
    readonly maxNodes: number;
    readonly maxParallel: number;
  };
  readonly cancellationPolicy: "cancel_unstarted_and_signal_active";
  readonly sensitivity: "internal" | "sensitive";
  readonly retiredAt: string | null;
}

export function snapshotCompositeDefinition(
  input: CompositeDefinitionRevision,
): CompositeDefinitionRevision {
  token(input.ref.id, "CompositeDefinition.ref.id");
  token(input.ref.revision, "CompositeDefinition.ref.revision");
  token(input.inputSchemaRevision, "CompositeDefinition.inputSchemaRevision");
  token(input.resultSchemaRevision, "CompositeDefinition.resultSchemaRevision");
  token(input.graphRevision, "CompositeDefinition.graphRevision");
  token(input.reducerId, "CompositeDefinition.reducerId");
  token(input.conflictPolicyRevision, "CompositeDefinition.conflictPolicyRevision");
  positive(input.limits.maxNodes, "CompositeDefinition.limits.maxNodes");
  positive(input.limits.maxParallel, "CompositeDefinition.limits.maxParallel");
  if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > input.limits.maxNodes) {
    throw new TypeError("CompositeDefinition nodes must be non-empty and within maxNodes.");
  }
  const ids = new Set<string>();
  const nodes = input.nodes.map((node, index) => {
    token(node.id, `CompositeDefinition.nodes[${index}].id`);
    if (ids.has(node.id)) throw new TypeError(`Duplicate composite node '${node.id}'.`);
    ids.add(node.id);
    token(node.operation.operation.namespace, `CompositeDefinition.nodes[${index}].operation.namespace`);
    token(node.operation.operation.name, `CompositeDefinition.nodes[${index}].operation.name`);
    token(node.operation.revision, `CompositeDefinition.nodes[${index}].operation.revision`);
    token(node.transformId, `CompositeDefinition.nodes[${index}].transformId`);
    if (node.conditionId !== null) token(node.conditionId, `CompositeDefinition.nodes[${index}].conditionId`);
    if (!Array.isArray(node.allowedBindings) || node.allowedBindings.length === 0) {
      throw new TypeError(`Composite node '${node.id}' requires allowed bindings.`);
    }
    return deepFreeze({
      ...node,
      allowedBindings: [...new Set(node.allowedBindings)],
      dependencies: [...node.dependencies],
      resourceClaims: node.resourceClaims.map((claim: CompositeResourceClaim) => ({ ...claim })),
    });
  });
  for (const node of nodes) {
    if (node.dependencies.some((dependency: string) => !ids.has(dependency) || dependency === node.id)) {
      throw new TypeError(`Composite node '${node.id}' has an invalid dependency.`);
    }
  }
  assertAcyclic(nodes);
  if (input.join.kind === "quorum") positive(input.join.count, "CompositeDefinition.join.count");
  if (input.retiredAt !== null) dateTime(input.retiredAt, "CompositeDefinition.retiredAt");
  return deepFreeze({
    ...input,
    ref: { ...input.ref },
    nodes,
    join: { ...input.join },
    limits: { ...input.limits },
  });
}

function assertAcyclic(nodes: readonly CompositeNodeDefinition[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new TypeError("CompositeDefinition graph must be acyclic.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

function token(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
}

function positive(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive integer.`);
  }
}

function dateTime(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${field} must be an ISO date-time.`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
