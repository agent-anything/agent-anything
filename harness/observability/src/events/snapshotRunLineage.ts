import {
  createDescendantRunLineage,
  createDescendantRunRelation,
  createRootRunLineage,
  type RunLineage,
} from "@agent-anything/agent-core/run-tree";

export function snapshotRunLineage(
  input: RunLineage,
  runId: string,
): RunLineage {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Run lineage must be an object.");
  }
  if (input.kind === "root") {
    if (input.root.id !== runId) {
      throw new TypeError("Root Run lineage must identify the event Run.");
    }
    return createRootRunLineage(input.root);
  }
  return createDescendantRunLineage(createDescendantRunRelation({
    relationId: input.relation.id,
    kind: "delegation",
    root: input.root,
    parent: input.parent,
    child: { id: runId },
    parentRunAction: input.parentRunAction,
    depth: input.depth,
  }));
}
