import type {
  ModelInputComposition,
  ModelInputContent,
  ModelInputLineage,
  ModelInputSection,
  ModelInputSectionRole,
  ModelInputSourceRef,
} from "./ModelInput.js";
import {
  modelInputFromSections,
  snapshotModelInputComposition,
} from "./ModelInput.js";
import type { ProviderInteraction } from "../ProviderInteraction.js";
import { snapshotProviderInteraction } from "../ProviderInteraction.js";

export interface ModelInputSectionCandidate {
  readonly id: string;
  readonly source: ModelInputSourceRef;
  readonly kind: string;
  readonly role: ModelInputSectionRole;
  readonly necessity: "mandatory" | "optional";
  readonly content: ModelInputContent;
}

export type ModelInputCompositionFailureCode = "model_input_sections_invalid";

export interface ModelInputCompositionFailure {
  readonly code: ModelInputCompositionFailureCode;
  readonly message: string;
}

export class ModelInputCompositionError extends Error {
  readonly code: ModelInputCompositionFailureCode;

  constructor(readonly failure: ModelInputCompositionFailure) {
    super(failure.message);
    this.name = "ModelInputCompositionError";
    this.code = failure.code;
  }
}

export function composeModelInput(input: {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly interaction: ProviderInteraction;
  readonly sections: readonly ModelInputSectionCandidate[];
  readonly lineage: ModelInputLineage;
  readonly composedAt: string;
}): ModelInputComposition {
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new ModelInputCompositionError(Object.freeze({
      code: "model_input_sections_invalid",
      message: "Model input sections must be non-empty.",
    }));
  }
  const sections = input.sections.map((section): ModelInputSection => Object.freeze({
    id: section.id,
    source: section.source,
    kind: section.kind,
    role: section.role,
    necessity: section.necessity,
    content: section.content,
  }));
  const projectedInput = modelInputFromSections(sections);
  return snapshotModelInputComposition({
    id: input.id,
    providerId: input.providerId,
    model: input.model,
    interaction: snapshotProviderInteraction(input.interaction),
    sections,
    instructions: projectedInput.instructions,
    messages: projectedInput.messages,
    lineage: input.lineage,
    composedAt: input.composedAt,
  });
}

export function modelInputFromComposition(
  composition: Pick<ModelInputComposition, "instructions" | "messages">,
): Pick<ModelInputComposition, "instructions" | "messages"> {
  return Object.freeze({
    instructions: composition.instructions,
    messages: composition.messages,
  });
}
