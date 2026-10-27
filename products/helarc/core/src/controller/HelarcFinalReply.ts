import type { TaskDecisionModelItem, ModelInteractionProjection } from "@agent-anything/agent-runtime/decision";
import { snapshotModelCallRef, type ModelCallableRequest } from "@agent-anything/model-interaction";
import type { HelarcOutputSource } from "../run/presentation/HelarcRunPresentation.js";

export const HELARC_FINAL_REPLY_REVISION = "helarc.final-reply.v1";
export const HELARC_FINAL_REPLY_CONTENT_GUIDANCE = [
  "Optional response is the complete final reply delivered to the caller, not an ending reason or an acknowledgement that a reply was written. Supplying it replaces, not appends to, earlier assistant text.",
  "To return an already-written report, omit response to adopt ordinary assistant text from this turn or, if absent, the immediately preceding Model Turn of this Run; no confirmation sentence or repeated report is needed.",
  "If neither turn has text, no final reply is supplied. Adoption does not redisplay existing text.",
  "Supply an empty string to explicitly provide no reply and prevent adoption.",
].join(" ");
export const HELARC_FINAL_REPLY_RECIPIENT_GUIDANCE = [
  "The final reply is delivered to the caller: the user for root work, or the Parent Agent for delegated work.",
  "The Parent receives the resolved final reply, not the Child's conversation history. Do not assume the Parent has read earlier Child messages.",
].join(" ");
export function createHelarcEndingSignalFeedback(input: {readonly hasText: boolean; readonly hasPlan: boolean}): string {
  return [
    "No callable request or ending signal was received. Ordinary text alone does not end this Run.",
    input.hasText
      ? "Your ordinary text from this turn is retained. If you want to end with that reply, make the next response a native final_result call without response and without another ordinary-text acknowledgement."
      : "If you want to end, make a native final_result call. Supply response for a new final reply; omit it to adopt eligible existing text, if any.",
    input.hasPlan
      ? "A Plan exists: include its complete final snapshot in plan, with actual step statuses. Do not use empty arguments or mark unfinished steps completed just to end."
      : 'No Plan exists. To end without replacing existing text, call final_result with arguments {}. To supply a new reply, use {"response":"<complete reply>"}.',
    "A supplied response replaces the reply delivered to the caller; it is not a completion confirmation. A Parent receives that selected reply, not your private conversation history.",
    "If further work is needed, request the appropriate available function instead.",
  ].join(" ");
}

export interface HelarcFinalReplyResolution {
  readonly protocolRevision: typeof HELARC_FINAL_REPLY_REVISION;
  readonly runId: string;
  readonly interactionRevision: string;
  readonly ending: { readonly modelItemId: string; readonly call: ModelCallableRequest["modelCallRef"] };
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
  readonly call: ModelCallableRequest;
  readonly modelItems: readonly TaskDecisionModelItem[];
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
