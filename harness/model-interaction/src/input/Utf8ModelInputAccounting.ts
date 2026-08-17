import type { ProviderMessage } from "../ProviderMessage.js";
import type {
  ModelInputCapability,
  ModelInputContent,
  ModelInputSection,
} from "./ModelInput.js";
import { snapshotModelInputCapability, snapshotModelInputComposition } from "./ModelInput.js";
import type {
  ModelInputSectionCandidate,
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
  renderFraming(sections: readonly ModelInputSection[]): string;
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
  const estimateSection = (candidate: ModelInputSectionCandidate): ModelInputSection =>
    Object.freeze({
      ...candidate,
      content: snapshotContent(candidate.content),
      accounting: Object.freeze({
        unit: "bytes" as const,
        amount: utf8Length(renderContent(candidate.content)),
      }),
    });
  const estimateFraming = (sections: readonly ModelInputSection[]) =>
    Object.freeze({
      ref: Object.freeze({ ...input.framing }),
      unit: "bytes" as const,
      amount: utf8Length(input.renderFraming(sections)),
    });

  return Object.freeze({
    providerId: input.providerId,
    model: input.model,
    capability,
    estimateSection,
    estimateFraming,
    verify(value: ProviderModelInputVerificationInput) {
      if (value.providerId !== input.providerId || value.model !== input.model) {
        throw new TypeError("Provider request identity does not match Model Input Accounting.");
      }
      const composition = snapshotModelInputComposition(value.composition);
      if (
        composition.providerId !== input.providerId ||
        composition.model !== input.model ||
        !sameCapability(composition, capability)
      ) {
        throw new TypeError("Provider request composition does not match its accounting capability.");
      }
      if (value.messages.length !== composition.sections.length) {
        throw new TypeError("Provider message count does not match model-input sections.");
      }
      const measured = composition.sections.map((section, index) => {
        const message = value.messages[index];
        if (
          message === undefined ||
          message.role !== section.role ||
          message.content !== renderContent(section.content)
        ) {
          throw new TypeError("Provider messages diverge from model-input sections.");
        }
        return estimateSection(section);
      });
      const framing = estimateFraming(measured);
      if (
        framing.ref.id !== composition.framing.ref.id ||
        framing.ref.revision !== composition.framing.ref.revision ||
        framing.amount !== composition.framing.amount ||
        measured.some((section, index) =>
          section.accounting.amount !== composition.sections[index]?.accounting.amount
        )
      ) {
        throw new TypeError("Provider request encoding does not match model-input accounting.");
      }
    },
  });
}

export function providerMessagesFromComposition(
  sections: readonly ModelInputSection[],
): ProviderMessage[] {
  return sections.map((section) => ({
    role: section.role,
    content: renderContent(section.content),
    metadata: Object.freeze({ modelInputSectionId: section.id }),
  }));
}

function snapshotContent(content: ModelInputContent): ModelInputContent {
  return content.kind === "text"
    ? Object.freeze({ kind: "text", text: content.text })
    : Object.freeze({ kind: "structured", value: content.value });
}

function renderContent(content: ModelInputContent): string {
  return content.kind === "text" ? content.text : JSON.stringify(content.value);
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
