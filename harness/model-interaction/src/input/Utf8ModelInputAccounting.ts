import {
  modelMessagesEqual,
  snapshotModelMessage,
  snapshotModelMessages,
  type ModelMessage,
} from "../ModelMessage.js";
import { snapshotJsonValue } from "../ModelInteractionContractValidation.js";
import {
  providerInteractionsEqual,
  snapshotProviderInteraction,
  type ProviderInteraction,
} from "../ProviderInteraction.js";
import type {
  ModelInputCapability,
  ModelInputContent,
  ModelInputSection,
} from "./ModelInput.js";
import {
  modelMessagesFromSections,
  snapshotModelInputCapability,
  snapshotModelInputComposition,
} from "./ModelInput.js";
import type {
  ModelInputSectionCandidate,
  ProviderEncodedModelInputVerificationInput,
  ProviderModelInputAccounting,
  ProviderModelInputVerificationInput,
} from "./ModelInputComposition.js";

export interface CreateUtf8ModelInputAccountingInput {
  readonly providerId: string;
  readonly model: string;
  readonly maximumInputBytes: number;
  readonly limitSource: "provider_reported" | "host_configured";
  readonly estimator: { readonly id: string; readonly revision: string };
  readonly framing: { readonly id: string; readonly revision: string };
  renderRequest(
    messages: readonly ModelMessage[],
    interaction: ProviderInteraction,
  ): string;
}

export function createUtf8ModelInputAccounting(
  input: CreateUtf8ModelInputAccountingInput,
): ProviderModelInputAccounting {
  const capability = snapshotModelInputCapability({
    supported: true,
    limit: {
      unit: "bytes",
      maximum: input.maximumInputBytes,
      source: input.limitSource,
    },
    estimator: {
      id: input.estimator.id,
      revision: input.estimator.revision,
      unit: "bytes",
      accuracy: "exact",
    },
    framingEstimator: {
      id: input.framing.id,
      revision: input.framing.revision,
      unit: "bytes",
      accuracy: "exact",
    },
  });
  if (!capability.supported) {
    throw new TypeError("UTF-8 Model Input Accounting must be supported.");
  }

  const estimateSection = (candidate: ModelInputSectionCandidate): ModelInputSection => {
    const content = snapshotContent(candidate.content);
    return Object.freeze({
      ...candidate,
      content,
      accounting: Object.freeze({
        unit: "bytes" as const,
        amount: modelInputContentPayloadAmount(content),
      }),
    });
  };

  const estimateFraming = (
    messages: readonly ModelMessage[],
    interaction: ProviderInteraction,
  ) => {
    const messageSnapshot = snapshotModelMessages(messages);
    const interactionSnapshot = snapshotProviderInteraction(interaction);
    const encodedAmount = utf8Length(input.renderRequest(messageSnapshot, interactionSnapshot));
    const payloadAmount = semanticMessagePayloadAmount(messageSnapshot);
    if (encodedAmount < payloadAmount) {
      throw new TypeError("Provider request framing cannot be smaller than message payload.");
    }
    return Object.freeze({
      ref: Object.freeze({ ...input.framing }),
      unit: "bytes" as const,
      amount: encodedAmount - payloadAmount,
    });
  };

  const verify = (value: ProviderModelInputVerificationInput): void => {
    if (value.providerId !== input.providerId || value.model !== input.model) {
      throw new TypeError("Provider request identity does not match Model Input Accounting.");
    }
    const composition = snapshotModelInputComposition(value.composition);
    const messages = snapshotModelMessages(value.messages);
    const interaction = snapshotProviderInteraction(value.interaction);
    if (
      composition.providerId !== input.providerId ||
      composition.model !== input.model ||
      !sameCapability(composition, capability) ||
      !modelMessagesEqual(messages, composition.messages) ||
      !providerInteractionsEqual(interaction, composition.interaction)
    ) {
      throw new TypeError("Provider request composition does not match its accounting capability.");
    }
    if (!modelMessagesEqual(messages, modelMessagesFromSections(composition.sections))) {
      throw new TypeError("Provider messages diverge from model-input sections.");
    }
    const measuredSections = composition.sections.map((section) => estimateSection(section));
    const sectionAmount = measuredSections.reduce(
      (total, section) => total + section.accounting.amount,
      0,
    );
    const framing = estimateFraming(messages, interaction);
    if (
      framing.ref.id !== composition.framing.ref.id ||
      framing.ref.revision !== composition.framing.ref.revision ||
      framing.amount !== composition.framing.amount ||
      sectionAmount !== composition.accounting.sectionAmount ||
      sectionAmount + framing.amount !== composition.accounting.inputAmount ||
      measuredSections.some((section, index) =>
        section.accounting.amount !== composition.sections[index]?.accounting.amount)
    ) {
      throw new TypeError("Provider request encoding does not match model-input accounting.");
    }
  };

  return Object.freeze({
    providerId: input.providerId,
    model: input.model,
    capability,
    estimateSection,
    estimateFraming,
    verify,
    verifyEncoded(value: ProviderEncodedModelInputVerificationInput) {
      verify(value);
      const expected = input.renderRequest(
        snapshotModelMessages(value.messages),
        snapshotProviderInteraction(value.interaction),
      );
      if (value.encodedRequest !== expected) {
        throw new TypeError("Final Provider request differs from the accounted encoding.");
      }
    },
  });
}

export function modelMessagesFromComposition(
  composition: Pick<ReturnType<typeof snapshotModelInputComposition>, "messages">,
): readonly ModelMessage[] {
  return snapshotModelMessages(composition.messages);
}

function snapshotContent(content: ModelInputContent): ModelInputContent {
  if (content.kind === "text") {
    return Object.freeze({ kind: "text", text: content.text });
  }
  if (content.kind === "structured") {
    return Object.freeze({
      kind: "structured",
      value: snapshotJsonValue(content.value, "ModelInputContent.value"),
    });
  }
  return Object.freeze({
    kind: "model_message",
    message: snapshotModelMessage(content.message),
  });
}

function modelInputContentPayloadAmount(content: ModelInputContent): number {
  if (content.kind === "text") return utf8Length(content.text);
  if (content.kind === "structured") return utf8Length(JSON.stringify(content.value));
  return semanticMessagePayloadAmount([content.message]);
}

function semanticMessagePayloadAmount(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + message.content.reduce(
    (messageTotal, block) => {
      if (block.kind === "text") return messageTotal + utf8Length(block.text);
      if (block.kind === "model_tool_call") {
        return messageTotal + utf8Length(JSON.stringify({
          name: block.call.name,
          input: block.call.input,
        }));
      }
      return messageTotal + utf8Length(JSON.stringify({
        name: block.result.name,
        settlement: block.result.settlement,
        content: block.result.content,
      }));
    }, 0), 0);
}

function sameCapability(
  composition: ReturnType<typeof snapshotModelInputComposition>,
  capability: Extract<ModelInputCapability, { readonly supported: true }>,
): boolean {
  return composition.limit.unit === capability.limit.unit &&
    composition.limit.maximum === capability.limit.maximum &&
    composition.limit.source === capability.limit.source &&
    composition.estimator.id === capability.estimator.id &&
    composition.estimator.revision === capability.estimator.revision &&
    composition.estimator.unit === capability.estimator.unit;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
