import {
  snapshotModelTurn,
  type ModelTurn,
} from "@agent-anything/model-interaction";
import type { ControllerModelItem } from "./Controller.js";

export function createControllerModelItems(
  input: ModelTurn,
  metadata: Readonly<Record<string, unknown>> = Object.freeze({}),
): readonly [ControllerModelItem, ...ControllerModelItem[]] {
  const turn = snapshotModelTurn(input);
  const safeMetadata = Object.freeze({ ...metadata });
  const items: ControllerModelItem[] = turn.assistant.content.map((block, ordinal) =>
    block.kind === "text"
      ? Object.freeze({
          id: `${turn.turnId}:content:${ordinal}`,
          kind: "assistant_text" as const,
          turnId: turn.turnId,
          contentBlockOrdinal: ordinal,
          text: block.text,
          metadata: safeMetadata,
        })
      : Object.freeze({
          id: block.call.modelCallRef.id,
          kind: "model_tool_call" as const,
          call: block.call,
          metadata: safeMetadata,
        })
  );
  items.push(Object.freeze({
    id: `${turn.turnId}:finish`,
    kind: "model_turn_finish",
    turnId: turn.turnId,
    finish: turn.finish,
    metadata: safeMetadata,
  }));
  items.push(Object.freeze({
    id: `${turn.turnId}:response`,
    kind: "model_response_correlation",
    turnId: turn.turnId,
    response: turn.responseRef,
    usage: turn.usage,
    metadata: safeMetadata,
  }));
  return Object.freeze(items) as readonly [ControllerModelItem, ...ControllerModelItem[]];
}
