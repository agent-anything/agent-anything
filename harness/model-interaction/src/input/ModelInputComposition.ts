import type {
  ModelInputCapability,
  ModelInputComposition,
  ModelInputContent,
  ModelInputFraming,
  ModelInputLineage,
  ModelInputSection,
  ModelInputSectionRole,
  ModelInputSourceRef,
  ModelOutputReserve,
} from "./ModelInput.js";
import {
  modelInputFromSections,
  snapshotModelInputCapability,
  snapshotModelInputComposition,
} from "./ModelInput.js";
import type { ModelMessage } from "../ModelMessage.js";
import type { ModelInstructions } from "../ModelInstructions.js";
import {
  snapshotProviderInteraction,
  type ProviderInteraction,
} from "../ProviderInteraction.js";

export interface ModelInputSectionCandidate {
  readonly id: string;
  readonly source: ModelInputSourceRef;
  readonly kind: string;
  readonly role: ModelInputSectionRole;
  readonly necessity: "mandatory" | "optional";
  readonly content: ModelInputContent;
}

export interface ProviderModelInputVerificationInput {
  readonly providerId: string;
  readonly model: string;
  readonly instructions: ModelInstructions;
  readonly messages: readonly ModelMessage[];
  readonly interaction: ProviderInteraction;
  readonly composition: ModelInputComposition;
}

export interface ProviderEncodedModelInputVerificationInput
  extends ProviderModelInputVerificationInput {
  readonly encodedRequest: string;
}

export interface ProviderModelInputAccounting {
  readonly providerId: string;
  readonly model: string;
  readonly capability: ModelInputCapability;
  estimateSection(candidate: ModelInputSectionCandidate): ModelInputSection;
  estimateFraming(
    instructions: ModelInstructions,
    messages: readonly ModelMessage[],
    interaction: ProviderInteraction,
  ): ModelInputFraming;
  verify(input: ProviderModelInputVerificationInput): void;
  verifyEncoded(input: ProviderEncodedModelInputVerificationInput): void;
}

export interface ModelInputContextAllocation {
  readonly unit: ModelInputSection["accounting"]["unit"];
  readonly amount: number;
  readonly baseSections: readonly ModelInputSection[];
  readonly framing: ModelInputFraming;
  readonly remainingAmount: number;
}

export type ModelInputCompositionFailureCode =
  | "model_input_accounting_unsupported"
  | "model_input_mandatory_overflow"
  | "model_input_context_budget_exceeded"
  | "model_input_accounting_invalid";

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

export function allocateModelInputContext(input: {
  readonly accounting: ProviderModelInputAccounting;
  readonly outputReserve: ModelOutputReserve;
  readonly interaction: ProviderInteraction;
  readonly baseSections: readonly ModelInputSectionCandidate[];
  readonly maximumContextAmount: number;
}): ModelInputContextAllocation {
  const capability = requireCapability(input.accounting);
  assertReserve(input.outputReserve, capability.estimator.unit);
  const interaction = snapshotProviderInteraction(input.interaction);
  if (!Number.isSafeInteger(input.maximumContextAmount) || input.maximumContextAmount < 0) {
    compositionFailure(
      "model_input_accounting_invalid",
      "Maximum Context allocation must be a non-negative safe integer.",
    );
  }
  const baseSections = estimateSections(input.accounting, input.baseSections);
  const baseInput = modelInputFromSections(baseSections);
  const framing = input.accounting.estimateFraming(
    baseInput.instructions,
    baseInput.messages,
    interaction,
  );
  assertFraming(framing, capability.estimator.unit);
  const sectionAmount = sumSections(baseSections);
  const remainingAmount = capability.limit.maximum -
    input.outputReserve.amount - framing.amount - sectionAmount;
  if (remainingAmount < 0) {
    compositionFailure(
      "model_input_mandatory_overflow",
      "Mandatory non-Context model input exceeds the effective input limit.",
    );
  }
  return Object.freeze({
    unit: capability.estimator.unit,
    amount: Math.min(remainingAmount, input.maximumContextAmount),
    baseSections,
    framing,
    remainingAmount,
  });
}

export function composeModelInput(input: {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly accounting: ProviderModelInputAccounting;
  readonly outputReserve: ModelOutputReserve;
  readonly interaction: ProviderInteraction;
  readonly contextBudget: { readonly unit: ModelInputSection["accounting"]["unit"]; readonly amount: number };
  readonly contextProjectedAmount: number;
  readonly sections: readonly ModelInputSectionCandidate[];
  readonly lineage: ModelInputLineage;
  readonly composedAt: string;
}): ModelInputComposition {
  const capability = requireCapability(input.accounting);
  assertReserve(input.outputReserve, capability.estimator.unit);
  const interaction = snapshotProviderInteraction(input.interaction);
  if (
    input.contextBudget.unit !== capability.estimator.unit ||
    !Number.isSafeInteger(input.contextBudget.amount) ||
    input.contextBudget.amount < 0 ||
    !Number.isSafeInteger(input.contextProjectedAmount) ||
    input.contextProjectedAmount < 0
  ) {
    compositionFailure(
      "model_input_accounting_invalid",
      "Context model-input accounting is invalid.",
    );
  }
  if (input.contextProjectedAmount > input.contextBudget.amount) {
    compositionFailure(
      "model_input_context_budget_exceeded",
      "Context Projection exceeds its granted model-input budget.",
    );
  }
  const sections = estimateSections(input.accounting, input.sections);
  const projectedInput = modelInputFromSections(sections);
  const framing = input.accounting.estimateFraming(
    projectedInput.instructions,
    projectedInput.messages,
    interaction,
  );
  assertFraming(framing, capability.estimator.unit);
  const sectionAmount = sumSections(sections);
  const inputAmount = sectionAmount + framing.amount;
  const remainingAmount = capability.limit.maximum -
    inputAmount - input.outputReserve.amount;
  if (remainingAmount < 0) {
    compositionFailure(
      "model_input_mandatory_overflow",
      "Complete mandatory model input exceeds the effective input limit.",
    );
  }
  return snapshotModelInputComposition({
    id: input.id,
    providerId: input.providerId,
    model: input.model,
    estimator: capability.estimator,
    limit: capability.limit,
    outputReserve: input.outputReserve,
    interaction,
    framing,
    contextBudget: input.contextBudget,
    sections,
    instructions: projectedInput.instructions,
    messages: projectedInput.messages,
    lineage: input.lineage,
    accounting: {
      unit: capability.estimator.unit,
      sectionAmount,
      framingAmount: framing.amount,
      inputAmount,
      outputReserveAmount: input.outputReserve.amount,
      remainingAmount,
    },
    composedAt: input.composedAt,
  });
}

function requireCapability(
  accounting: ProviderModelInputAccounting,
): Extract<ModelInputCapability, { readonly supported: true }> {
  if (accounting === null || typeof accounting !== "object") {
    return compositionFailure(
      "model_input_accounting_unsupported",
      "Provider Model Input Accounting is unavailable.",
    );
  }
  const capability = snapshotModelInputCapability(accounting.capability);
  if (!capability.supported) {
    return compositionFailure(
      "model_input_accounting_unsupported",
      "Provider does not support exact model-input accounting.",
    );
  }
  return capability;
}

function estimateSections(
  accounting: ProviderModelInputAccounting,
  candidates: readonly ModelInputSectionCandidate[],
): readonly ModelInputSection[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return compositionFailure(
      "model_input_accounting_invalid",
      "Model input sections must be non-empty.",
    );
  }
  const sections = candidates.map((candidate) => accounting.estimateSection(candidate));
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    return compositionFailure(
      "model_input_accounting_invalid",
      "Model input section identities must be unique.",
    );
  }
  return Object.freeze(sections);
}

function sumSections(sections: readonly ModelInputSection[]): number {
  return sections.reduce((total, section) => total + section.accounting.amount, 0);
}

function assertReserve(reserve: ModelOutputReserve, unit: string): void {
  if (
    reserve.unit !== unit ||
    !Number.isSafeInteger(reserve.amount) ||
    reserve.amount < 0
  ) {
    compositionFailure(
      "model_input_accounting_invalid",
      "Model output reserve must use the Provider accounting unit.",
    );
  }
}

function assertFraming(framing: ModelInputFraming, unit: string): void {
  if (
    framing.unit !== unit ||
    !Number.isSafeInteger(framing.amount) ||
    framing.amount < 0
  ) {
    compositionFailure(
      "model_input_accounting_invalid",
      "Provider framing accounting is invalid.",
    );
  }
}

function compositionFailure(
  code: ModelInputCompositionFailureCode,
  message: string,
): never {
  throw new ModelInputCompositionError(Object.freeze({ code, message }));
}
