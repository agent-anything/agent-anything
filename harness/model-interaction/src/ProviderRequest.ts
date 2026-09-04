
import {
  snapshotModelContinuationRef,
  type ModelContinuationRef,
} from "./continuation/index.js";
import {
  modelInstructionsEqual,
  snapshotModelInstructions,
  type ModelInstructions,
} from "./ModelInstructions.js";
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
import {
  snapshotModelContextAssessment,
  snapshotModelContextHeadroom,
  snapshotProviderRequestedOutput,
  type ModelContextAssessment,
  type ModelContextHeadroom,
  type ProviderRequestedOutput,
} from "./context/index.js";

export interface ProviderRequest {
  readonly requestId: string;
  readonly purpose: string;
  readonly correlation: ProviderRequestCorrelation;
  readonly instructions: ModelInstructions;
  readonly messages: readonly ModelMessage[];
  readonly interaction: ProviderInteraction;
  readonly composition: ModelInputComposition;
  readonly modelContext: ProviderRequestModelContext;
  readonly continuation: ModelContinuationRef | null;
  readonly metadata: { readonly [key: string]: ModelJsonValue };
}

export interface ProviderRequestModelContext {
  readonly requestedOutput: ProviderRequestedOutput;
  readonly headroom: ModelContextHeadroom;
  readonly assessment: ModelContextAssessment | null;
}

export interface ProviderRequestCorrelation {
  readonly controllerRequestId: string;
  readonly branchId: string;
}

export function snapshotProviderRequest(input: ProviderRequest): ProviderRequest {
  strictRecord(input, "ProviderRequest", [
    "requestId", "purpose", "correlation", "instructions", "messages", "interaction", "composition",
    "modelContext", "continuation", "metadata",
  ]);
  const instructions = snapshotModelInstructions(input.instructions);
  const messages = snapshotModelMessages(input.messages);
  const interaction = snapshotProviderInteraction(input.interaction);
  const composition = snapshotModelInputComposition(input.composition);
  const modelContext = snapshotProviderRequestModelContext(input.modelContext);
  if (
    input.requestId !== composition.id ||
    !modelInstructionsEqual(instructions, composition.instructions) ||
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
    instructions,
    messages,
    interaction,
    composition,
    modelContext,
    continuation: input.continuation === null
      ? null
      : snapshotModelContinuationRef(input.continuation),
    metadata: metadata as { readonly [key: string]: ModelJsonValue },
  });
}

export function createProviderSemanticRequestDigest(input: ProviderRequest): string {
  const request = snapshotProviderRequest(input);
  return `sha256:${createHash("sha256").update(JSON.stringify({
    requestId: request.requestId,
    purpose: request.purpose,
    correlation: request.correlation,
    instructions: request.instructions,
    messages: request.messages,
    interaction: request.interaction,
    composition: request.composition,
    requestedOutput: request.modelContext.requestedOutput,
    headroom: request.modelContext.headroom,
    continuation: request.continuation,
    metadata: request.metadata,
  }), "utf8").digest("hex")}`;
}

function snapshotProviderRequestModelContext(
  input: ProviderRequestModelContext,
): ProviderRequestModelContext {
  return Object.freeze({
    requestedOutput: snapshotProviderRequestedOutput(input.requestedOutput),
    headroom: snapshotModelContextHeadroom(input.headroom),
    assessment: input.assessment === null
      ? null
      : snapshotModelContextAssessment(input.assessment),
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
import { createHash } from "node:crypto";
