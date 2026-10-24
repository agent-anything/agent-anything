import {snapshotContextMaterialRefs} from "@agent-anything/context/material";
import {OperationCommitError} from "@agent-anything/operation-catalog/result";
import type {HelarcMaterialHandoff} from "@agent-anything/helarc/tools";
import type {HelarcExecutionStore} from "./HelarcExecutionStore.js";

export function createHelarcMaterialHandoff(store: HelarcExecutionStore): HelarcMaterialHandoff {
  return {async project(result) {
    const childId = result.correlation.child.run.id, parentId = result.correlation.origin.parent.run.id;
    const initial = await store.readRunCommit(`${childId}:commit:0`);
    const head = await store.readLatestRun(childId);
    const request = initial?.admission?.delegationRequest;
    if (!request || !head?.state.settlement || request.ref.id !== result.request.id || request.ref.revision !== result.request.revision ||
        request.origin.parent.run.id !== parentId) throw new OperationCommitError("helarc.material-handoff", result.ref.id);
    if (head.state.status !== "completed") return [];
    const output = head.state.finalOutput as {materialRefs?: unknown} | null;
    const references = snapshotContextMaterialRefs(output?.materialRefs ?? []);
    // The Child's accepted terminal checkpoint already transferred and retained these exact versions.
    await store.contextMaterials.validate(parentId, references);
    return references;
  }};
}
