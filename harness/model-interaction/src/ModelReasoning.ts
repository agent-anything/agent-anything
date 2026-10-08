import { strictRecord, token } from "./ModelInteractionContractValidation.js";

/** Provider-returned data, never Controller instructions or executable content. */
export interface ModelReasoning {
  readonly text: string;
  readonly replay: { readonly format: string; readonly binding: string } | null;
}

export function snapshotModelReasoning(value: ModelReasoning): ModelReasoning {
  strictRecord(value, "ModelReasoning", ["text", "replay"]);
  if (typeof value.text !== "string" || value.text.length > 131_072) {
    throw new TypeError("Model reasoning must be bounded text.");
  }
  if (value.replay === null) return Object.freeze({ text: value.text, replay: null });
  strictRecord(value.replay, "ModelReasoning.replay", ["format", "binding"]);
  return Object.freeze({ text: value.text, replay: Object.freeze({
    format: token(value.replay.format, "ModelReasoning.replay.format"),
    binding: token(value.replay.binding, "ModelReasoning.replay.binding"),
  }) });
}
