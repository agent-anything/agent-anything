import type { AgentTask } from "@agent-anything/agent-core/task";
import type {
  DelegationContextMaterial,
  DelegationContextMaterialRef,
  DelegationRequest,
} from "./DelegationRequest.js";
import { snapshotDelegationContextMaterial } from "./DelegationRequest.js";

export interface DelegationContextConstructionAssessment {
  readonly rootPurpose: DelegationContextMaterial;
  readonly omitted: readonly DelegationContextMaterialRef[];
}

export function assessDelegationContextConstruction(input: {
  readonly request: DelegationRequest;
  readonly rootTask: AgentTask;
  readonly rootPurpose: DelegationContextMaterial;
}): DelegationContextConstructionAssessment {
  if (
    input.request.origin.root.task.id !== input.rootTask.id ||
    input.request.rootPurposeAnchor.id !== input.rootTask.id
  ) {
    throw new TypeError("Delegation root-purpose source does not match the root Task.");
  }
  const rootPurpose = snapshotDelegationContextMaterial(input.rootPurpose);
  if (
    rootPurpose.ref.id !== input.rootTask.id ||
    rootPurpose.ref.kind !== "root_task_purpose" ||
    !sameMaterial(rootPurpose.ref, input.request.rootPurposeAnchor)
  ) {
    throw new TypeError("Delegation root-purpose material is stale or invalid.");
  }
  const omitted: DelegationContextMaterialRef[] = [];
  for (const entry of input.request.contextPlan.entries) {
    if (entry.role === "root_purpose") continue;
    if (entry.necessity === "mandatory") {
      throw new TypeError(
        `Mandatory delegation Context role '${entry.role}' has no admitted source owner.`,
      );
    }
    omitted.push(entry.material);
  }
  return Object.freeze({
    rootPurpose,
    omitted: Object.freeze(omitted.map((material) => Object.freeze({ ...material }))),
  });
}

function sameMaterial(
  left: DelegationContextMaterialRef,
  right: DelegationContextMaterialRef,
): boolean {
  return left.owner === right.owner &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision;
}
