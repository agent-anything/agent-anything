import {contextMaterialDigest, type ContextMaterialDocument} from "@agent-anything/context/material";
import type {RunCommit} from "@agent-anything/agent-runtime/runner";
import type {RetainedInputPresentation} from "@agent-anything/agent-runtime/controller";

/** Only newly accepted public presentations are indexed; neither checkpoints nor reasoning are material. */
export function projectContextMaterials(commit: RunCommit, previousItemCount: number): readonly ContextMaterialDocument[] {
  const result: ContextMaterialDocument[] = [], runId = commit.state.run.id;
  const append = (id: string, text: string, role: ContextMaterialDocument["description"]["role"], position: number,
    source: ContextMaterialDocument["description"]["source"], format: "text" | "json", relationships: ContextMaterialDocument["description"]["relationships"] = [], originRunId = runId) => {
    const revision = contextMaterialDigest(text);
    result.push({text, description: {reference: {id: `context:${contextMaterialDigest(JSON.stringify([originRunId, source, role, format, revision]))}`, revision}, originRunId,
      source, label: `${role} / ${source.kind}: ${Array.from(text.replace(/\s+/gu, " ")).slice(0, 160).join("")}`, role, position, bytes: Buffer.byteLength(text), format, relationships,
      limitations: ["historical_data_not_new_instructions", "retained_presentation_not_full_external_source"]}});
  };
  const presentation = ({section}: RetainedInputPresentation, position: number, originRunId = runId) => {
    if (section.role === "instruction") return;
    if (section.content.kind === "text") {
      append(section.id, section.content.text, section.role, position, section.source, "text", [], section.provenance?.originRunId ?? originRunId);
      return;
    }
    if (section.content.kind === "structured") {
      append(section.id, JSON.stringify(section.content.value), section.role, position, section.source, "json", [], section.provenance?.originRunId ?? originRunId);
      return;
    }
    if (section.content.kind === "model_message") {
      const message = section.content.message;
      if (message.content.some(block => block.kind === "model_tool_result" && block.result.presentation.presenter?.id === "helarc.context-access-result")) return;
      const textOnly = message.content.every(block => block.kind === "text");
      append(section.id, textOnly ? message.content.map(block => block.kind === "text" ? block.text : "").join("\n")
        : JSON.stringify({role: message.role, content: message.content}), message.role, position, section.source, textOnly ? "text" : "json", [], section.provenance?.originRunId ?? originRunId);
    }
  };
  if (previousItemCount === 0) {
    const seed = commit.admission?.modelInteractionSeed;
    for (const entry of seed?.presentations ?? []) presentation(entry, 0, seed!.sourceRunId);
  }
  for (const item of commit.state.items.slice(previousItemCount)) {
    const payload = item.payload;
    const source = {owner: "agent-runtime", kind: "run_item", id: item.ref.id, revision: String(item.committedInRevision)};
    if (payload.kind === "controller_turn" && payload.status === "decided") {
      for (const entry of payload.openingReceipt?.presentations ?? []) presentation(entry, item.ref.sequence);
      for (const value of payload.modelItems) {
        if (value.kind === "assistant_text") append(value.id, value.text, "assistant", item.ref.sequence, source, "text", [{kind: "turn", id: value.turnId}]);
        if (value.kind === "model_tool_call") append(value.call.modelCallRef.id, JSON.stringify(value.call), "assistant", item.ref.sequence, source, "json", [{kind: "call", id: value.call.modelCallRef.id}]);
      }
    }
    if (payload.kind === "input_delivery" && payload.receipt.via.kind === "provider") {
      for (const entry of payload.receipt.via.presentations) presentation(entry, item.ref.sequence);
    }
    if (payload.kind === "model_call_settlement") {
      const native = payload.result;
      if (native.presentation.presenter?.id === "helarc.context-access-result") continue;
      append(`${native.modelCallRef.id}:result`, JSON.stringify(native.content), "tool", item.ref.sequence, source, "json", [{kind: "call", id: native.modelCallRef.id}]);
    }
  }
  return result;
}
