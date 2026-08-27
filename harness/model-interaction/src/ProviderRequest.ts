
import {
  snapshotModelContinuationRef,
  type ModelContinuationRef,
} from "./continuation/index.js";
import {
  modelMessagesEqual,
  snapshotModelMessages,
  type ModelMessage,
} from "./ModelMessage.js";
import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import {
  snapshotJsonValue,
  strictRecord,
  token,
} from "./ModelInteractionContractValidation.js";
import {
  providerInteractionsEqual,
  snapshotProviderInteraction,
  type ProviderInteraction,
} from "./ProviderInteraction.js";
import {
  snapshotModelInputComposition,
  type ModelInputComposition,
} from "./input/index.js";

export interface ProviderRequest {
  readonly requestId: string;
  readonly purpose: string;
  readonly correlation: ProviderRequestCorrelation;
  readonly messages: readonly ModelMessage[];
  readonly interaction: ProviderInteraction;
  readonly composition: ModelInputComposition;
  readonly continuation: ModelContinuationRef | null;
  readonly metadata: { readonly [key: string]: ModelJsonValue };
}

export interface ProviderRequestCorrelation {
  readonly controllerRequestId: string;
  readonly branchId: string;
}

export function snapshotProviderRequest(input: ProviderRequest): ProviderRequest {
  strictRecord(input, "ProviderRequest", [
    "requestId", "purpose", "correlation", "messages", "interaction", "composition",
    "continuation", "metadata",
  ]);
  const messages = snapshotModelMessages(input.messages);
  const interaction = snapshotProviderInteraction(input.interaction);
  const composition = snapshotModelInputComposition(input.composition);
  if (
    input.requestId !== composition.id ||
    !modelMessagesEqual(messages, composition.messages) ||
    !providerInteractionsEqual(interaction, composition.interaction)
  ) {
    throw new TypeError("Provider request does not match its Model Input Composition.");
  }
  const metadata = snapshotJsonValue(input.metadata, "ProviderRequest.metadata");
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("ProviderRequest.metadata must be a JSON object.");
  }
  return Object.freeze({
    requestId: token(input.requestId, "ProviderRequest.requestId"),
    purpose: token(input.purpose, "ProviderRequest.purpose"),
    correlation: snapshotProviderRequestCorrelation(input.correlation),
    messages,
    interaction,
    composition,
    continuation: input.continuation === null
      ? null
      : snapshotModelContinuationRef(input.continuation),
    metadata: metadata as { readonly [key: string]: ModelJsonValue },
  });
}

function snapshotProviderRequestCorrelation(
  input: ProviderRequestCorrelation,
): ProviderRequestCorrelation {
  strictRecord(input, "ProviderRequest.correlation", [
    "controllerRequestId", "branchId",
  ]);
  return Object.freeze({
    controllerRequestId: token(
      input.controllerRequestId,
      "ProviderRequest.correlation.controllerRequestId",
    ),
    branchId: token(input.branchId, "ProviderRequest.correlation.branchId"),
  });
}
