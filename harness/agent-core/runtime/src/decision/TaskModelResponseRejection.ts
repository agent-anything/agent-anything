import {modelInputValueDigest} from "@agent-anything/model-interaction/input";
import type {ProviderRequest, ProviderResponse} from "@agent-anything/model-interaction";

/** Input may be accepted even when no part of the returned model turn is usable as conversation. */
export interface TaskModelResponseRejection {
  readonly version: 1;
  readonly runId: string;
  readonly controllerRequestId: string;
  readonly requestId: string;
  readonly rawResultId: string;
  readonly responseAcceptanceId: string;
  readonly responseDigest: string;
  readonly reason: "output_limit" | "invalid_turn";
  readonly digest: string;
}

export function createTaskModelResponseRejection(input: {
  readonly runId: string; readonly request: ProviderRequest; readonly response: ProviderResponse;
  readonly rawResultId: string; readonly responseAcceptanceId: string; readonly reason: TaskModelResponseRejection["reason"];
}): TaskModelResponseRejection {
  const value = {version: 1 as const, runId: input.runId, controllerRequestId: input.request.correlation.controllerRequestId,
    requestId: input.request.requestId, rawResultId: input.rawResultId, responseAcceptanceId: input.responseAcceptanceId,
    responseDigest: modelInputValueDigest(input.response), reason: input.reason};
  const rejection = snapshotTaskModelResponseRejection({...value, digest: modelInputValueDigest(value)});
  validateTaskModelResponseRejectionRaw(rejection, input.response, input.request);
  return rejection;
}

export function snapshotTaskModelResponseRejection(value: TaskModelResponseRejection): TaskModelResponseRejection {
  const {digest, ...body} = value;
  if (value.version !== 1 || !["output_limit", "invalid_turn"].includes(value.reason) || digest !== modelInputValueDigest(body) ||
      [value.runId, value.controllerRequestId, value.requestId, value.rawResultId, value.responseAcceptanceId, value.responseDigest]
        .some(token => typeof token !== "string" || !token.trim())) throw new TypeError("task_response_rejection_invalid");
  return Object.freeze({...value});
}

export function validateTaskModelResponseRejectionRaw(value: TaskModelResponseRejection, response: ProviderResponse, request: ProviderRequest): void {
  snapshotTaskModelResponseRejection(value);
  const responseRef = response?.kind === "native_tool_turn" ? response.turn?.responseRef : null;
  if (value.requestId !== request.requestId || value.controllerRequestId !== request.correlation.controllerRequestId ||
      (responseRef?.requestId != null && responseRef.requestId !== request.requestId) ||
      (responseRef?.providerId != null && responseRef.providerId !== request.composition.providerId))
    throw new TypeError("task_response_rejection_binding_changed");
  const outputLimit = response?.kind === "native_tool_turn" && response.turn?.finish?.kind === "output_limit";
  if (value.responseDigest !== modelInputValueDigest(response) || (value.reason === "output_limit") !== outputLimit)
    throw new TypeError("task_response_rejection_raw_changed");
}
