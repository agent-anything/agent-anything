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
}): ModelInteractionProjection {
  const messages: ModelMessage[] = [];
  const unsettled = new Map<string, ModelToolCall>();
  const settled = new Set<string>();
  const callOrder = new Map<string, number>();
  let nextCallOrder = 0;
  let pendingResults: Array<{
    readonly order: number;
    readonly result: ModelToolResult;
  }> = [];

  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    messages.push(snapshotModelMessage({
      role: "tool",
      content: [...pendingResults].sort((left, right) => left.order - right.order)
        .map(({ result }) => Object.freeze({
        kind: "model_tool_result" as const,
        result,
      })),
    }));
    pendingResults = [];
  };

  for (const item of input.items) {
    if (item.payload.kind === "controller_turn") {
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
      messages.push(projected.message);
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
      pendingResults.push(Object.freeze({ order: callOrder.get(key)!, result }));
    }
  }

  flushResults();
  return Object.freeze({
    id: `${input.runId}:model-interaction`,
    revision: String(input.runRevision),
    messages: Object.freeze(messages),
    unsettledCalls: Object.freeze([...unsettled.values()]),
    settledCallCount: settled.size,
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

  return Object.freeze({
    message: snapshotModelMessage({ role: "assistant", content }) as Extract<
      ModelMessage,
      { readonly role: "assistant" }
    >,
    calls: Object.freeze(calls),
  });
}

function projectionFailure(code: string, message: string): ModelInteractionProjectionError {
  return new ModelInteractionProjectionError(code, message);
}
