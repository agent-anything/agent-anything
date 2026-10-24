import {createExactModelWorkingView, modelInputValueDigest} from "../input/ModelWorkingView.js";
import {validateModelAccountScope, type ModelInputAccount} from "../input/ModelInputAccounts.js";
import type {ModelInputSection} from "../input/ModelInput.js";
import type {ContextTransformationBasis} from "./ModelContextTransformation.js";

export interface ContextTransformationNode {
  readonly id: string;
  readonly sourceIds: readonly string[];
  readonly inputs: readonly string[];
  readonly level: "internal_node" | "final_adoption";
}
export type ContextTransformationStagePlan = {readonly kind: "planned"; readonly nodes: readonly ContextTransformationNode[];
  readonly sourceBytes: number; readonly maximumCompletedRequests: number} |
  {readonly kind: "unavailable"; readonly reason: "indivisible_scope" | "node_limit" | "declared_companion_crosses_partition"};

/** Partition only known legal closed units. Bytes bound work, not semantic independence or token fit. */
export function planContextTransformationStages(basis: ContextTransformationBasis,
  limits: {readonly maximumSourceBytes: number; readonly maximumNodes: number}): ContextTransformationStagePlan {
  if (!Number.isSafeInteger(limits.maximumSourceBytes) || limits.maximumSourceBytes < 1 ||
      !Number.isSafeInteger(limits.maximumNodes) || limits.maximumNodes < 1 || limits.maximumNodes > 256) throw new TypeError("Invalid transformation work limits.");
  const sourceBytes = Buffer.byteLength(JSON.stringify(basis.evidence));
  const allIds = basis.sources.map(section => section.id);
  if (sourceBytes <= limits.maximumSourceBytes) return {kind: "planned", nodes: [{id: "root", sourceIds: allIds, inputs: [], level: "final_adoption"}],
    sourceBytes, maximumCompletedRequests: 2};
  // Use the full original view so the final closed exchange is not misclassified as active.
  const byId = new Map([...basis.sources, ...basis.background].map(section => [section.id, section]));
  const all = basis.sourceOrder.map(id => byId.get(id)!);
  const view = createExactModelWorkingView({sections: all, recipientRunId: basis.recipientRunId, boundary: "request"});
  const units: ModelInputSection[][] = [];
  for (let position = 0; position < basis.sources.length;) {
    const section = basis.sources[position]!;
    const native = view.nativeGroups.find(group => group.sectionIds.includes(section.id));
    const unit = native ? native.sectionIds.map(id => byId.get(id)!) : [section];
    if (unit.some(value => !allIds.includes(value.id)) || Buffer.byteLength(JSON.stringify(unit)) > limits.maximumSourceBytes) {
      return {kind: "unavailable", reason: "indivisible_scope"};
    }
    units.push(unit); position += unit.length;
  }
  const partitions: ModelInputSection[][] = [];
  let current: ModelInputSection[] = [];
  for (const unit of units) {
    if (current.length && Buffer.byteLength(JSON.stringify([...current, ...unit])) > limits.maximumSourceBytes) {partitions.push(current); current = [];}
    current.push(...unit);
  }
  if (current.length) partitions.push(current);
  if (partitions.length + 1 > limits.maximumNodes) return {kind: "unavailable", reason: "node_limit"};
  for (const partition of partitions) {
    validateModelAccountScope(all, partition.map(section => section.id), basis.recipientRunId);
    if (partition.some(section => section.preservation!.relationships.some(relation => basis.sources.some(other =>
      modelInputValueDigest(other.source) === modelInputValueDigest(relation.source) && !partition.includes(other))))) {
      return {kind: "unavailable", reason: "declared_companion_crosses_partition"};
    }
  }
  const leaves = partitions.map((partition, index) => ({id: `leaf-${index}`, sourceIds: partition.map(section => section.id), inputs: [], level: "internal_node" as const}));
  return {kind: "planned", sourceBytes, maximumCompletedRequests: (leaves.length + 1) * 2,
    nodes: [...leaves, {id: "root", sourceIds: allIds, inputs: leaves.map(node => node.id), level: "final_adoption"}]};
}

export function contextTransformationNodeBasis(root: ContextTransformationBasis, node: ContextTransformationNode,
  accounts: readonly ModelInputAccount[]): ContextTransformationBasis {
  const sources = root.sources.filter(section => node.sourceIds.includes(section.id));
  if (sources.length !== node.sourceIds.length || sources.some((section, index) => section.id !== node.sourceIds[index])) throw new TypeError("Node source order changed.");
  if (accounts.length !== node.inputs.length || new Set(accounts.map(account => account.id)).size !== accounts.length ||
      accounts.some(account => account.recipientRunId !== root.recipientRunId || account.derivation.assessmentLevel !== "internal_node") ||
      accounts.length && modelInputValueDigest(accounts.flatMap(account => account.sources.map(source => source.sectionId))) !== modelInputValueDigest(node.sourceIds)) {
    throw new TypeError("Merge input coverage or recipient changed.");
  }
  const evidence = accounts.length ? accounts.map(account => account.section) : sources;
  const value = {...root, sources, evidence, assessmentLevel: node.level,
    inheritedLimitations: [...new Set([...root.inheritedLimitations, ...accounts.flatMap(account => account.limitations),
      ...(accounts.length ? ["assessment_uses_derived_accounts_not_original_reread"] : [])]) ]};
  const {id: _id, ...basis} = value;
  return {...basis, id: `transformation:${modelInputValueDigest(basis)}`};
}
