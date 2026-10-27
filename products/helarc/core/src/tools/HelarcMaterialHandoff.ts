import {ContextMaterialError, snapshotContextMaterialRefs, type ContextMaterialAccessPort, type ContextMaterialRef} from "@agent-anything/context/material";
import type {DelegationResult} from "@agent-anything/agent-runtime/delegation";
import type {ProviderResponse} from "@agent-anything/model-interaction";

export interface HelarcMaterialHandoff {
  project(result: DelegationResult): Promise<readonly ContextMaterialRef[]>;
}

/** Validation does not publish or transfer. Publication follows accepted ending commit. */
export async function validateHelarcFinalMaterials(response: ProviderResponse, runId: string, access?: ContextMaterialAccessPort): Promise<string | null> {
  if (response.kind !== "native_tool_turn") return null;
  try {
    for (const block of response.turn.assistant.content) {
      if (block.kind !== "model_tool_call" || block.call.name !== "final_result" || block.call.input.material_refs === undefined) continue;
      const refs = snapshotContextMaterialRefs(block.call.input.material_refs);
      if (!refs.length) continue;
      if (!access) throw new ContextMaterialError("context_access_unavailable", "Retained material handoff is unavailable in this host.");
      await access.validate(runId, refs);
    }
    return null;
  } catch (error) {
    if (!(error instanceof ContextMaterialError)) throw error;
    return `${error.code}: ${error.message} Copy accessible references from ContextMaterialSearch, or omit the attachment; successful work need not be repeated.`;
  }
}
