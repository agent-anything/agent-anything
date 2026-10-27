import type { ContextRepresentationPreparationSupport } from "@agent-anything/agent-runtime/context-representation";
import type {ModelInputSourceRef} from "@agent-anything/model-interaction/input";
import {snapshotContextMaterialRefs} from "@agent-anything/context/material";
import type {HelarcExecutionStore} from "./HelarcExecutionStore.js";

export const HELARC_CONTEXT_PREPARATION_BINDING = Object.freeze({revision: "source-grounded-preparation.v3",
  semantic: {revision: "source-grounded-account.v2", work: {maximumSourceBytes: 64 * 1024, maximumNodes: 9},
    prefix: {enabled: true as const, revision: "compatible-prefix.v1"},
    background: {enabled: true as const, revision: "run-owned-generation.v1"}}});

/** Context preparation cannot manufacture access to undisclosed source material. */
export function createHelarcContextPreparation(store: HelarcExecutionStore): ContextRepresentationPreparationSupport {
  const references = (values: readonly ModelInputSourceRef[]) => {
    if (values.some(value => value.owner !== "context" || value.kind !== "material" || !value.revision)) {
      throw new TypeError("Context preparation material owner is unsupported.");
    }
    return snapshotContextMaterialRefs(values.map(value => ({id: value.id, revision: value.revision!})));
  };
  return {store: store.contextPreparations, semantic: HELARC_CONTEXT_PREPARATION_BINDING.semantic, materials: {
    validate: (runId, values) => store.contextMaterials.validate(runId, references(values)),
    hold: (runId, consumerId, values, purpose) => store.contextMaterialRetention.prepare({id: consumerId,
      sourceRunId: runId, recipientRunId: runId, references: references(values), basis: {kind: purpose, id: consumerId}}),
    release: consumerId => store.contextMaterialRetention.release(consumerId),
  }};
}
