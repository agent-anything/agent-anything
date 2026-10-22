import {
  modelCallRefKey,
  snapshotModelMessage,
  snapshotModelToolResult,
  type ModelAssistantContentBlock,
  type ModelMessage,
  type ModelToolCall,
  type ModelToolResult,
} from "@agent-anything/model-interaction";
import type { RunItem } from "../run/RunItem.js";
import { retainInputPresentation, snapshotInputDeliveryReceipt } from "./ControllerInputDelivery.js";
import { snapshotConversationOpeningReceipt, snapshotModelConversationSeed, type ModelConversationSeed } from "./ControllerConversation.js";
import type { ModelInputSourceRef } from "@agent-anything/model-interaction/input";
import type {
  ControllerModelItem,
  ModelInteractionProjection,
} from "./Controller.js";

export class ModelInteractionProjectionError extends TypeError {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ModelInteractionProjectionError";
  }
}

export function projectModelInteraction(input: {
  readonly runId: string;
  readonly runRevision: number;
  readonly items: readonly RunItem[];
  readonly seed?: ModelConversationSeed | null;
}): ModelInteractionProjection {
  const seed = input.seed ? snapshotModelConversationSeed(input.seed) : null;
  const messages: ModelMessage[] = [];
  let opening: ModelInteractionProjection["opening"] = null;
  const historyPresentations: NonNullable<ModelInteractionProjection["historyPresentations"]>[number][] = [];
  const append = (message: ModelMessage, sources: readonly ModelInputSourceRef[]) => {
    const section = {id: `${input.runId}:history:${messages.length}`, source: sources[0]!, kind: "interaction_history",
      role: message.role, necessity: "mandatory" as const, content: {kind: "model_message" as const, message},
      provenance: {purpose: "accepted_exchange", recipientRunId: input.runId, author: message.role === "assistant" ? "model" : "capability",
        sources, presenter: {owner: "agent-runtime", kind: "presenter", id: "model-interaction-history", revision: "1"},
        coverage: sources.map(source => `${source.id}@${source.revision}`), limitations: []}};
    historyPresentations.push(retainInputPresentation(section));
    messages.push(message);
  };
  const unsettled = new Map<string, ModelToolCall>();
  const settled = new Set<string>();
  const callOrder = new Map<string, number>();
  let nextCallOrder = 0;
  let latestTurn: ModelInteractionProjection["latestTurn"] = null;
  const notificationHistory: NonNullable<ModelInteractionProjection["notificationHistory"]>[number][] = [];
  let pendingResults: Array<{
    readonly order: number;
    readonly result: ModelToolResult;
    readonly source: ModelInputSourceRef;
  }> = [];

  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    append(snapshotModelMessage({
      role: "tool",
      content: [...pendingResults].sort((left, right) => left.order - right.order)
        .map(({ result }) => Object.freeze({
        kind: "model_tool_result" as const,
        result,
      })),
    }), pendingResults.map(entry => entry.source));
    pendingResults = [];
  };

  for (const [index, item] of input.items.entries()) {
    if (item.payload.kind === "input_delivery") {
      flushResults();
      const {batch, receipt, turn} = item.payload;
      const next = input.items[index + 1];
      if (unsettled.size > 0 || batch.runId !== input.runId || next?.payload.kind !== "controller_turn" ||
          next.payload.status !== "decided" || next.payload.turn.id !== turn.id ||
          next.committedInRevision !== item.committedInRevision) {
        throw projectionFailure("input_delivery_history_invalid", "Input delivery must immediately precede its atomically committed Controller Turn, after all Call results.");
      }
      const retainedReceipt = snapshotInputDeliveryReceipt(receipt, batch)!;
      if (retainedReceipt.via.kind === "provider") {
        const requestId = retainedReceipt.via.requestId;
        if (next.payload.modelItems.some(value => value.kind === "model_response_correlation" && value.response.requestId !== requestId)) {
          throw projectionFailure("input_delivery_request_mismatch", "Accepted input must belong to the response request.");
        }
      }
      if (retainedReceipt.via.kind === "provider") for (const [entryIndex, entry] of batch.entries.entries()) {
        const presentation = retainedReceipt.via.presentations[entryIndex]!;
        notificationHistory.push(Object.freeze({messageIndex: messages.length, batchId: batch.id,
          batchRevision: batch.revision, sequence: entry.sequence, presentation}));
        if (presentation.section.content.kind !== "model_message") throw projectionFailure("input_presentation_invalid", "Notification presentation must be a message.");
        messages.push(presentation.section.content.message);
        historyPresentations.push(presentation);
      }
      continue;
    }
    if (item.payload.kind === "controller_turn") {
      if (item.payload.openingReceipt) {
        if (opening || latestTurn || item.payload.status !== "decided") throw projectionFailure("conversation_opening_repeated", "Opening may only be accepted with the first decided Turn.");
        opening = snapshotConversationOpeningReceipt(item.payload.openingReceipt, input.runId);
        if (item.payload.modelItems.some(value => value.kind === "model_response_correlation" && value.response.requestId !== opening!.requestId)) {
          throw projectionFailure("conversation_opening_request_mismatch", "Accepted opening must belong to the response request.");
        }
      }
      flushResults();
      if (unsettled.size > 0) {
        throw projectionFailure(
          "model_call_unsettled_before_next_turn",
          "A Controller turn cannot begin while a prior model call is unsettled.",
        );
      }
      if (item.payload.status !== "decided" || item.payload.modelItems.length === 0) {
        continue;
      }
      const projected = projectControllerTurn(item.payload.modelItems);
      latestTurn = Object.freeze({
        runId: input.runId,
        runItemId: item.ref.id,
        runItemSequence: item.ref.sequence,
        turnId: item.payload.modelItems.find(model => model.kind === "model_turn_finish")!.turnId,
        textBlocks: Object.freeze(item.payload.modelItems.flatMap(model => model.kind === "assistant_text"
          ? [Object.freeze({ modelItemId: model.id, ordinal: model.contentBlockOrdinal, text: model.text })] : [])),
      });
      append(projected.message, [{owner: "agent-runtime", kind: "run_item", id: item.ref.id,
        revision: String(item.committedInRevision), runId: input.runId}]);
      for (const call of projected.calls) {
        const key = modelCallRefKey(call.modelCallRef);
        if (unsettled.has(key) || settled.has(key)) {
          throw projectionFailure(
            "model_call_identity_duplicated",
            "A model call identity cannot appear more than once in Run history.",
          );
        }
        unsettled.set(key, call);
        callOrder.set(key, nextCallOrder);
        nextCallOrder += 1;
      }
      continue;
    }

    if (item.payload.kind === "model_call_settlement") {
      const result = snapshotModelToolResult(item.payload.result);
      const key = modelCallRefKey(result.modelCallRef);
      const call = unsettled.get(key);
      if (call === undefined || settled.has(key)) {
        throw projectionFailure(
          "model_call_settlement_uncorrelated",
          "A model-call settlement must correlate to one open call exactly once.",
        );
      }
      if (
        result.name !== call.name ||
        JSON.stringify(result.providerCallRef) !== JSON.stringify(call.providerCallRef)
      ) {
        throw projectionFailure(
          "model_call_settlement_mismatch",
          "A model-call settlement must preserve the original callable correlation.",
        );
      }
      unsettled.delete(key);
      settled.add(key);
      pendingResults.push(Object.freeze({ order: callOrder.get(key)!, result,
        source: {owner: "agent-runtime", kind: "run_item", id: item.ref.id, revision: String(item.committedInRevision), runId: input.runId} }));
    }
  }

  flushResults();
  return Object.freeze({
    id: `${input.runId}:model-interaction`,
    revision: String(input.runRevision),
    messages: Object.freeze(messages),
    unsettledCalls: Object.freeze([...unsettled.values()]),
    settledCallCount: settled.size,
    latestTurn,
    notificationHistory: Object.freeze(notificationHistory),
    opening, seed, historyPresentations: Object.freeze(historyPresentations),
  });
}

function projectControllerTurn(items: readonly ControllerModelItem[]): {
  readonly message: Extract<ModelMessage, { readonly role: "assistant" }>;
  readonly calls: readonly ModelToolCall[];
} {
  const contentItems = items.filter((item) =>
    item.kind === "assistant_text" || item.kind === "model_tool_call"
  );
  const finishItems = items.filter((item) => item.kind === "model_turn_finish");
  const correlationItems = items.filter((item) =>
    item.kind === "model_response_correlation"
  );
  if (finishItems.length !== 1 || correlationItems.length !== 1) {
    throw projectionFailure(
      "controller_model_turn_incomplete",
      "A decided model turn requires one finish and one response-correlation item.",
    );
  }
  const turnId = finishItems[0]!.turnId;
  if (correlationItems[0]!.turnId !== turnId) {
    throw projectionFailure(
      "controller_model_turn_correlation_invalid",
      "Controller model items must refer to one Model Turn.",
    );
  }

  const content: ModelAssistantContentBlock[] = [];
  const calls: ModelToolCall[] = [];
  for (let ordinal = 0; ordinal < contentItems.length; ordinal += 1) {
    const item = contentItems[ordinal]!;
    if (item.kind === "assistant_text") {
      if (item.turnId !== turnId || item.contentBlockOrdinal !== ordinal) {
        throw projectionFailure(
          "controller_model_content_order_invalid",
          "Assistant text order does not match the normalized Model Turn.",
        );
      }
      content.push(Object.freeze({ kind: "text", text: item.text }));
      continue;
    }
    if (
      item.call.modelCallRef.turnId !== turnId ||
      item.call.ordinal !== ordinal ||
      item.call.modelCallRef.contentBlockOrdinal !== ordinal
    ) {
      throw projectionFailure(
        "controller_model_content_order_invalid",
        "Model Tool Call order does not match the normalized Model Turn.",
      );
    }
    content.push(Object.freeze({ kind: "model_tool_call", call: item.call }));
    calls.push(item.call);
  }

  const reasoning = items.filter(item => item.kind === "assistant_reasoning");
  if (reasoning.length > 1 || reasoning.some(item => item.turnId !== turnId)) {
    throw projectionFailure("controller_model_reasoning_invalid", "Reasoning must belong to the same Model Turn.");
  }
  return Object.freeze({
    message: snapshotModelMessage({ role: "assistant", content,
      ...(reasoning[0] ? { reasoning: reasoning[0].reasoning } : {}),
    }) as Extract<
      ModelMessage,
      { readonly role: "assistant" }
    >,
    calls: Object.freeze(calls),
  });
}

function projectionFailure(code: string, message: string): ModelInteractionProjectionError {
  return new ModelInteractionProjectionError(code, message);
}
