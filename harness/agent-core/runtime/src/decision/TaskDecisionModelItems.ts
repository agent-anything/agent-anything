import {
  snapshotModelTurn,
  type ModelTurn,
} from "@agent-anything/model-interaction";
import type { TaskDecisionModelItem } from "./TaskDecisionActivity.js";
import { snapshotModelPurposeEvidence, nativeModelSourceKey, sameRevisionRef, type ModelPurposeEvidence } from "@agent-anything/model-interaction/protocol";
import { snapshotModelCallableRequest, type ModelCallableRequest } from "@agent-anything/model-interaction";
import {snapshotModelCallRef} from "@agent-anything/model-interaction";
import type {TaskModelCallCorrelation} from "./TaskDecisionActivity.js";

export function snapshotTaskModelCallCorrelation(call:TaskModelCallCorrelation):TaskModelCallCorrelation {
  const modelCallRef=snapshotModelCallRef(call.modelCallRef);
  if(typeof call.name!=="string"||!call.name||!Number.isSafeInteger(call.ordinal)||call.ordinal<0||
    (call.providerCallRef!==null&&(typeof call.providerCallRef.id!=="string"||!call.providerCallRef.id||typeof call.providerCallRef.providerId!=="string"||!call.providerCallRef.providerId)))
    throw new TypeError("task_call_correlation_invalid");
  return Object.freeze({modelCallRef,name:call.name,ordinal:call.ordinal,providerCallRef:call.providerCallRef?Object.freeze({...call.providerCallRef}):null});
}

export function sameTaskProviderCall(left:TaskModelCallCorrelation["providerCallRef"],right:TaskModelCallCorrelation["providerCallRef"]):boolean {
  return left===null||right===null?left===right:left.providerId===right.providerId&&left.id===right.id;
}

/** A purpose view contains original references and local requests, never a normalized native response. */
export function createNativeTaskModelItems(evidence: ModelPurposeEvidence, calls: readonly ModelCallableRequest[]): readonly TaskDecisionModelItem[] {
  const retained = snapshotModelPurposeEvidence(evidence);
  const sources = new Set(retained.sources.map(nativeModelSourceKey));
  const requests = calls.map(snapshotModelCallableRequest);
  if (requests.some(call => call.modelCallRef.turnId !== null || !sameRevisionRef(call.modelCallRef.purposeAcceptance, retained.acceptance) ||
      !sources.has(nativeModelSourceKey(call.modelCallRef.nativeSource))))
    throw new TypeError("native_task_call_source_mismatch");
  return Object.freeze([
    Object.freeze({ id: `purpose-evidence:${retained.acceptance.id}:${retained.acceptance.revision}`, kind: "native_purpose_evidence" as const,
      evidence: retained, metadata: Object.freeze({}) }),
    ...requests.map(call => Object.freeze({ id: call.modelCallRef.id, kind: "model_tool_call" as const, call, metadata: Object.freeze({}) })),
  ]);
}

export function createControllerModelItems(
  input: ModelTurn,
  metadata: Readonly<Record<string, unknown>> = Object.freeze({}),
): readonly [TaskDecisionModelItem, ...TaskDecisionModelItem[]] {
  const turn = snapshotModelTurn(input);
  const safeMetadata = Object.freeze({ ...metadata });
  const items: TaskDecisionModelItem[] = turn.assistant.content.map((block, ordinal) =>
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
  if (turn.assistant.reasoning !== undefined) items.push(Object.freeze({
    id: `${turn.turnId}:reasoning`, kind: "assistant_reasoning", turnId: turn.turnId,
    reasoning: turn.assistant.reasoning, metadata: safeMetadata,
  }));
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
  return Object.freeze(items) as readonly [TaskDecisionModelItem, ...TaskDecisionModelItem[]];
}
