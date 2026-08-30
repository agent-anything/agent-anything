import type {
  DelegationContextMaterial,
  DelegationContextMaterialRef,
  DelegationRequest,
} from "./DelegationRequest.js";
import { snapshotDelegationContextMaterial } from "./DelegationRequest.js";

export interface DelegationContextConstructionAssessment {
  readonly selected: readonly DelegationContextMaterial[];
  readonly omitted: readonly DelegationContextMaterialRef[];
}

export function assessDelegationContextConstruction(input: {
  readonly request: DelegationRequest;
  readonly materials: readonly DelegationContextMaterial[];
}): DelegationContextConstructionAssessment {
  if (!Array.isArray(input.materials)) {
    throw new TypeError("Delegation Context materials must be an array.");
  }
  const materials = input.materials.map(snapshotDelegationContextMaterial);
  const materialByRef = new Map(
    materials.map((material) => [materialRefKey(material.ref), material] as const),
  );
  if (materialByRef.size !== materials.length) {
    throw new TypeError("Delegation Context materials must be unique.");
  }

  const selected: DelegationContextMaterial[] = [];
  const omitted: DelegationContextMaterialRef[] = [];
  for (const entry of input.request.contextPlan.entries) {
    const material = materialByRef.get(materialRefKey(entry.material));
    if (material === undefined) {
      if (entry.necessity === "mandatory") {
        throw new TypeError(
          `Mandatory delegation Context role '${entry.role}' is unavailable.`,
        );
      }
      omitted.push(entry.material);
      continue;
    }
    selected.push(material);
  }

  const selectedKeys = new Set(selected.map(({ ref }) => materialRefKey(ref)));
  if (materials.some(({ ref }) => !selectedKeys.has(materialRefKey(ref)))) {
    throw new TypeError(
      "Delegation Context contains material that was not selected by the accepted plan.",
    );
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    omitted: Object.freeze(omitted.map((material) => Object.freeze({ ...material }))),
  });
}

function materialRefKey(input: DelegationContextMaterialRef): string {
  return `${input.owner}/${input.kind}/${input.id}@${input.revision}`;
}
