import type { ControllerModelItem, ModelInteractionProjection } from "@agent-anything/agent-runtime/controller";
import { snapshotModelCallRef, type ModelToolCall } from "@agent-anything/model-interaction";
import type { HelarcOutputSource } from "../run/presentation/HelarcRunPresentation.js";

export const HELARC_FINAL_REPLY_REVISION = "helarc.final-reply.v1";
export const HELARC_ENDING_SIGNAL_FEEDBACK = "To end this Run, call final_result. Omit response to adopt ordinary assistant text from that turn or, if absent, the immediately preceding Model Turn of this Run. Supply response for a new final reply, or an empty string for no final reply. Include the complete final Plan snapshot when a Plan exists. To continue work, use the functions supplied in the request. Ordinary text alone does not end the Run.";

export interface HelarcFinalReplyResolution {
  readonly protocolRevision: typeof HELARC_FINAL_REPLY_REVISION;
  readonly runId: string;
  readonly interactionRevision: string;
  readonly ending: { readonly modelItemId: string; readonly call: ModelToolCall["modelCallRef"] };
  readonly disposition: "supplied" | "explicit_empty" | "adopted_current" | "adopted_previous" | "no_text";
  readonly textJoin: "none" | "double_newline";
}

type ReplyBlock = { readonly modelItemId: string; readonly ordinal: number; readonly text: string };

export function selectHelarcFinalReplyText(args: {
  readonly input: Readonly<Record<string, unknown>>;
  readonly current: readonly ReplyBlock[];
  readonly previous: readonly ReplyBlock[];
}): { summary: string; disposition: HelarcFinalReplyResolution["disposition"]; blocks: readonly ReplyBlock[] } {
  if (Object.hasOwn(args.input, "response")) {
    if (typeof args.input.response !== "string") throw new TypeError("Supplied final reply must be a string.");
    return {summary: args.input.response, disposition: args.input.response === "" ? "explicit_empty" : "supplied", blocks: []};
  }
  const current = args.current.filter(block => block.text.trim());
  const blocks = (current.length ? current : args.previous.filter(block => block.text.trim())).map(block => Object.freeze({...block}));
  return {summary: blocks.map(block => block.text).join("\n\n"), blocks: Object.freeze(blocks),
    disposition: blocks.length === 0 ? "no_text" : current.length ? "adopted_current" : "adopted_previous"};
}

export function resolveHelarcFinalReply(input: {
  readonly runId: string;
  readonly interactionRevision: string;
  readonly call: ModelToolCall;
  readonly modelItems: readonly ControllerModelItem[];
  readonly previous: ModelInteractionProjection["latestTurn"];
}): { readonly summary: string; readonly source: HelarcOutputSource; readonly finalReply: HelarcFinalReplyResolution } {
  const item = input.modelItems.find(item => item.kind === "model_tool_call" && item.call.modelCallRef.id === input.call.modelCallRef.id);
  if (!item) throw new TypeError("Final reply requires its exact ending Call item.");
  const ending = Object.freeze({modelItemId: item.id, call: snapshotModelCallRef(input.call.modelCallRef)});
  const resolution = (disposition: HelarcFinalReplyResolution["disposition"], textJoin: HelarcFinalReplyResolution["textJoin"]): HelarcFinalReplyResolution =>
    Object.freeze({protocolRevision: HELARC_FINAL_REPLY_REVISION, runId: input.runId,
      interactionRevision: input.interactionRevision, ending, disposition, textJoin});
  const current = input.modelItems.flatMap(item => item.kind === "assistant_text" && item.turnId === ending.call.turnId
    ? [{modelItemId: item.id, ordinal: item.contentBlockOrdinal, text: item.text}] : []);
  const previous = input.previous;
  if (previous && previous.runId !== input.runId) throw new TypeError("Final reply history must belong to the same Run.");
  const selected = selectHelarcFinalReplyText({input: input.call.input, current, previous: previous?.textBlocks ?? []});
  if (selected.disposition === "supplied" || selected.disposition === "explicit_empty") {
    const response = selected.summary;
    return Object.freeze({summary: response, source: Object.freeze({kind: "model_control", turnId: ending.call.turnId,
      modelItemId: item.id, modelCallRef: ending.call, control: "final_result", argumentPath: "/response"}),
      finalReply: resolution(response === "" ? "explicit_empty" : "supplied", "none")});
  }
  const blocks = selected.blocks;
  if (blocks.length === 0) return Object.freeze({summary: "", source: Object.freeze({kind: "no_text"}), finalReply: resolution("no_text", "none")});
  const fromCurrent = selected.disposition === "adopted_current";
  const turnId = fromCurrent ? ending.call.turnId : previous!.turnId;
  return Object.freeze({summary: blocks.map(block => block.text).join("\n\n"),
    source: Object.freeze({kind: "model_text", turnId, modelItemIds: Object.freeze(blocks.map(block => block.modelItemId)),
      adopted: Object.freeze({runId: input.runId, runItem: fromCurrent ? null : Object.freeze({id: previous!.runItemId, sequence: previous!.runItemSequence}),
        blocks: Object.freeze(blocks)})}),
    finalReply: resolution(selected.disposition, "double_newline")});
}

export function validHelarcFinalReply(summary: string, source: HelarcOutputSource, value: unknown): value is HelarcFinalReplyResolution {
  if (!value || typeof value !== "object") return false;
  const r = value as HelarcFinalReplyResolution;
  if (r.protocolRevision !== HELARC_FINAL_REPLY_REVISION || typeof r.runId !== "string" || !r.runId ||
      typeof r.interactionRevision !== "string" || !r.interactionRevision || !r.ending ||
      typeof r.ending.modelItemId !== "string" || !r.ending.modelItemId) return false;
  try { snapshotModelCallRef(r.ending.call); } catch { return false; }
  if (r.disposition === "supplied" || r.disposition === "explicit_empty") {
    return r.textJoin === "none" && source.kind === "model_control" && source.modelItemId === r.ending.modelItemId &&
      JSON.stringify(source.modelCallRef) === JSON.stringify(r.ending.call) &&
      (r.disposition === "explicit_empty" ? summary === "" : summary !== "");
  }
  if (r.disposition === "no_text") return source.kind === "no_text" && summary === "" && r.textJoin === "none";
  if (r.disposition !== "adopted_current" && r.disposition !== "adopted_previous") return false;
  if (source.kind !== "model_text" || !source.adopted || source.adopted.runId !== r.runId || r.textJoin !== "double_newline") return false;
  const {blocks, runItem} = source.adopted;
  if (!Array.isArray(blocks) || !blocks.length || (runItem !== null &&
      (typeof runItem.id !== "string" || !runItem.id || !Number.isSafeInteger(runItem.sequence) || runItem.sequence < 1))) return false;
  if (r.disposition === "adopted_previous" && (runItem === null || source.turnId === r.ending.call.turnId)) return false;
  if (r.disposition === "adopted_current" && source.turnId !== r.ending.call.turnId) return false;
  return blocks.every((block, index) => block && typeof block.modelItemId === "string" && block.modelItemId &&
    Number.isSafeInteger(block.ordinal) && block.ordinal >= 0 && typeof block.text === "string" && block.text.trim() &&
    (index === 0 || blocks[index - 1]!.ordinal < block.ordinal)) &&
    new Set(blocks.map(block => block.modelItemId)).size === blocks.length &&
    JSON.stringify(source.modelItemIds) === JSON.stringify(blocks.map(block => block.modelItemId)) && summary === blocks.map(block => block.text).join("\n\n");
}
