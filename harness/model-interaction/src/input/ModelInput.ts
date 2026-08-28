import type { ModelJsonValue } from "../ModelInteractionContractValidation.js";
import {
  modelMessagesEqual,
  snapshotModelMessages,
  type ModelMessage,
} from "../ModelMessage.js";
import {
  snapshotProviderInteraction,
  type ProviderInteraction,
} from "../ProviderInteraction.js";
import {
  isoDateTime,
  nonNegativeInteger,
  nullableToken,
  snapshotJsonValue,
  strictRecord,
  token,
} from "../ModelInteractionContractValidation.js";

export type ModelInputUnit = "bytes" | "tokens";

export interface ModelInputEstimatorRef {
  readonly id: string;
  readonly revision: string;
  readonly unit: ModelInputUnit;
  readonly accuracy: "exact";
}

export interface ModelInputLimit {
  readonly unit: ModelInputUnit;
  readonly maximum: number;
  readonly source: "provider_reported" | "host_configured";
}

export type ModelInputCapability =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly limit: ModelInputLimit;
      readonly estimator: ModelInputEstimatorRef;
      readonly framingEstimator: {
        readonly id: string;
        readonly revision: string;
        readonly unit: ModelInputUnit;
        readonly accuracy: "exact";
      };
    };

export interface ModelOutputReserve {
  readonly unit: ModelInputUnit;
  readonly amount: number;
}

export interface ModelInputFraming {
  readonly ref: {
    readonly id: string;
    readonly revision: string;
  };
  readonly unit: ModelInputUnit;
  readonly amount: number;
}

export interface ModelInputSourceRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string | null;
}

export interface ModelInputTextContent {
  readonly kind: "text";
  readonly text: string;
}

export interface ModelInputStructuredContent {
  readonly kind: "structured";
  readonly value: ModelJsonValue;
}

export interface ModelInputMessageContent {
  readonly kind: "model_message";
  readonly message: ModelMessage;
}

export type ModelInputContent =
  | ModelInputTextContent
  | ModelInputStructuredContent
  | ModelInputMessageContent;

export type ModelInputSectionRole = "system" | "user" | "assistant" | "tool";

export interface ModelInputSection {
  readonly id: string;
  readonly source: ModelInputSourceRef;
  readonly kind: string;
  readonly role: ModelInputSectionRole;
  readonly necessity: "mandatory" | "optional";
  readonly content: ModelInputContent;
  readonly accounting: {
    readonly unit: ModelInputUnit;
    readonly amount: number;
  };
}

export interface ModelInputLineage {
  readonly instructionBinding: ModelInputSourceRef;
  readonly agent: ModelInputSourceRef;
  readonly instructions: ModelInputSourceRef;
  readonly instructionRelease: ModelInputSourceRef;
  readonly instructionResolver: ModelInputSourceRef;
  readonly instructionContent: ModelInputSourceRef;
  readonly instructionModel: {
    readonly providerId: string;
    readonly model: string;
  };
  readonly instructionBlocks: readonly ModelInputSourceRef[];
  readonly activeContext: ModelInputSourceRef | null;
  readonly contextProjection: ModelInputSourceRef | null;
  readonly projectionManifest: ModelInputSourceRef | null;
  readonly toolSelection: ModelInputSourceRef | null;
  readonly toolExposureContent: ModelInputSourceRef | null;
  readonly toolExposureBasis: ModelInputSourceRef | null;
  readonly toolExposureProof: ModelInputSourceRef | null;
  readonly toolGuidance: ModelInputSourceRef | null;
  readonly controllerControlGuidance: ModelInputSourceRef | null;
  readonly callableDefinitions: ModelInputSourceRef | null;
  readonly modelQualification: ModelInputSourceRef | null;
  readonly interactionHistory: ModelInputSourceRef | null;
  readonly protocol: ModelInputSourceRef;
  readonly policy: ModelInputSourceRef;
}

export interface ModelInputAccounting {
  readonly unit: ModelInputUnit;
  readonly sectionAmount: number;
  readonly framingAmount: number;
  readonly inputAmount: number;
  readonly outputReserveAmount: number;
  readonly remainingAmount: number;
}

export interface ModelInputComposition {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly estimator: ModelInputEstimatorRef;
  readonly limit: ModelInputLimit;
  readonly outputReserve: ModelOutputReserve;
  readonly interaction: ProviderInteraction;
  readonly framing: ModelInputFraming;
  readonly contextBudget: {
    readonly unit: ModelInputUnit;
    readonly amount: number;
  };
  readonly sections: readonly ModelInputSection[];
  readonly messages: readonly ModelMessage[];
  readonly lineage: ModelInputLineage;
  readonly accounting: ModelInputAccounting;
  readonly composedAt: string;
}

export function snapshotModelInputCapability(
  input: ModelInputCapability,
): ModelInputCapability {
  strictRecord(input, "ModelInputCapability", [
    "supported", "limit", "estimator", "framingEstimator",
  ]);
  if (input.supported === false) {
    strictRecord(input, "ModelInputCapability", ["supported"]);
    return Object.freeze({ supported: false });
  }
  if (input.supported !== true) {
    throw new TypeError("ModelInputCapability.supported must be boolean.");
  }
  const limit = snapshotLimit(input.limit, "ModelInputCapability.limit");
  const estimator = snapshotEstimator(input.estimator, "ModelInputCapability.estimator");
  const framingEstimator = snapshotEstimator(
    input.framingEstimator,
    "ModelInputCapability.framingEstimator",
  );
  if (limit.unit !== estimator.unit || limit.unit !== framingEstimator.unit) {
    throw new TypeError("ModelInputCapability must use one accounting unit.");
  }
  return Object.freeze({
    supported: true,
    limit,
    estimator,
    framingEstimator,
  });
}

export function snapshotModelInputComposition(
  input: ModelInputComposition,
): ModelInputComposition {
  strictRecord(input, "ModelInputComposition", [
    "id", "providerId", "model", "estimator", "limit", "outputReserve", "interaction",
    "framing", "contextBudget", "sections", "messages", "lineage", "accounting",
    "composedAt",
  ]);
  const estimator = snapshotEstimator(
    input.estimator,
    "ModelInputComposition.estimator",
  );
  const limit = snapshotLimit(input.limit, "ModelInputComposition.limit");
  const outputReserve = snapshotAmount(
    input.outputReserve,
    "ModelInputComposition.outputReserve",
    "amount",
  );
  const interaction = snapshotProviderInteraction(input.interaction);
  const framing = snapshotFraming(input.framing);
  const contextBudget = snapshotAmount(
    input.contextBudget,
    "ModelInputComposition.contextBudget",
    "amount",
  );
  const units = [
    limit.unit,
    outputReserve.unit,
    framing.unit,
    contextBudget.unit,
    estimator.unit,
  ];
  if (new Set(units).size !== 1) {
    throw new TypeError("ModelInputComposition must use one accounting unit.");
  }
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new TypeError("ModelInputComposition.sections must be non-empty.");
  }
  const sections = input.sections.map((section, index) =>
    snapshotSection(section, estimator.unit, `ModelInputComposition.sections[${index}]`),
  );
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    throw new TypeError("ModelInputComposition section identities must be unique.");
  }
  const messages = snapshotModelMessages(input.messages);
  if (!modelMessagesEqual(messages, modelMessagesFromSections(sections))) {
    throw new TypeError("ModelInputComposition messages diverge from its sections.");
  }
  const sectionAmount = sections.reduce(
    (total, section) => total + section.accounting.amount,
    0,
  );
  const inputAmount = framing.amount + sectionAmount;
  const remainingAmount = limit.maximum - inputAmount - outputReserve.amount;
  if (remainingAmount < 0) {
    throw new TypeError("ModelInputComposition exceeds the model input limit.");
  }
  const lineage = snapshotLineage(input.lineage);
  assertInstructionLineage({
    providerId: input.providerId,
    model: input.model,
    sections,
    lineage,
  });
  strictRecord(input.accounting, "ModelInputComposition.accounting", [
    "unit", "sectionAmount", "framingAmount", "inputAmount",
    "outputReserveAmount", "remainingAmount",
  ]);
  if (
    input.accounting.unit !== estimator.unit ||
    input.accounting.sectionAmount !== sectionAmount ||
    input.accounting.framingAmount !== framing.amount ||
    input.accounting.inputAmount !== inputAmount ||
    input.accounting.outputReserveAmount !== outputReserve.amount ||
    input.accounting.remainingAmount !== remainingAmount
  ) {
    throw new TypeError("ModelInputComposition accounting is inconsistent.");
  }
  return Object.freeze({
    id: token(input.id, "ModelInputComposition.id"),
    providerId: token(input.providerId, "ModelInputComposition.providerId"),
    model: token(input.model, "ModelInputComposition.model"),
    estimator,
    limit,
    outputReserve,
    interaction,
    framing,
    contextBudget,
    sections: Object.freeze(sections),
    messages,
    lineage,
    accounting: Object.freeze({
      unit: estimator.unit,
      sectionAmount,
      framingAmount: framing.amount,
      inputAmount,
      outputReserveAmount: outputReserve.amount,
      remainingAmount,
    }),
    composedAt: isoDateTime(input.composedAt, "ModelInputComposition.composedAt"),
  });
}

function assertInstructionLineage(input: {
  readonly providerId: string;
  readonly model: string;
  readonly sections: readonly ModelInputSection[];
  readonly lineage: ModelInputLineage;
}): void {
  if (
    input.lineage.instructionModel.providerId !== input.providerId ||
    input.lineage.instructionModel.model !== input.model
  ) {
    throw new TypeError("Model input instruction lineage must match the Provider model identity.");
  }
  const instructionSections = input.sections.filter(
    (section) => section.kind === "agent_instruction",
  );
  if (instructionSections.length !== input.lineage.instructionBlocks.length) {
    throw new TypeError("Model input instruction sections must match instruction block lineage.");
  }
  for (let index = 0; index < instructionSections.length; index += 1) {
    const section = instructionSections[index]!;
    const source = input.lineage.instructionBlocks[index]!;
    if (
      input.sections[index] !== section ||
      section.role !== "system" ||
      section.necessity !== "mandatory" ||
      !sameSource(section.source, source)
    ) {
      throw new TypeError(
        "Agent instruction sections must be the leading ordered mandatory system sections.",
      );
    }
  }
}

function sameSource(left: ModelInputSourceRef, right: ModelInputSourceRef): boolean {
  return left.owner === right.owner &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision;
}

function snapshotEstimator(
  input: ModelInputEstimatorRef,
  path: string,
): ModelInputEstimatorRef {
  strictRecord(input, path, [
    "id", "revision", "unit", "accuracy",
  ]);
  if (!isUnit(input.unit) || input.accuracy !== "exact") {
    throw new TypeError("Model input estimator must declare an exact supported unit.");
  }
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    revision: token(input.revision, `${path}.revision`),
    unit: input.unit,
    accuracy: "exact",
  });
}

function snapshotAmount<TField extends "amount" | "maximum">(
  input: { readonly unit: ModelInputUnit } & Readonly<Record<TField, number>>,
  path: string,
  field: TField,
): { readonly unit: ModelInputUnit } & Readonly<Record<TField, number>> {
  strictRecord(input, path, ["unit", field]);
  if (!isUnit(input.unit)) throw new TypeError(`${path}.unit is invalid.`);
  return Object.freeze({
    unit: input.unit,
    [field]: nonNegativeInteger(input[field], `${path}.${field}`),
  }) as { readonly unit: ModelInputUnit } & Readonly<Record<TField, number>>;
}

function snapshotLimit(input: ModelInputLimit, path: string): ModelInputLimit {
  strictRecord(input, path, ["unit", "maximum", "source"]);
  if (!isUnit(input.unit)) throw new TypeError(`${path}.unit is invalid.`);
  if (input.source !== "provider_reported" && input.source !== "host_configured") {
    throw new TypeError(`${path}.source is invalid.`);
  }
  return Object.freeze({
    unit: input.unit,
    maximum: nonNegativeInteger(input.maximum, `${path}.maximum`),
    source: input.source,
  });
}

function snapshotFraming(input: ModelInputFraming): ModelInputFraming {
  strictRecord(input, "ModelInputComposition.framing", ["ref", "unit", "amount"]);
  strictRecord(input.ref, "ModelInputComposition.framing.ref", ["id", "revision"]);
  if (!isUnit(input.unit)) throw new TypeError("ModelInputComposition.framing.unit is invalid.");
  return Object.freeze({
    ref: Object.freeze({
      id: token(input.ref.id, "ModelInputComposition.framing.ref.id"),
      revision: token(input.ref.revision, "ModelInputComposition.framing.ref.revision"),
    }),
    unit: input.unit,
    amount: nonNegativeInteger(input.amount, "ModelInputComposition.framing.amount"),
  });
}

function snapshotSection(
  input: ModelInputSection,
  unit: ModelInputUnit,
  path: string,
): ModelInputSection {
  strictRecord(input, path, [
    "id", "source", "kind", "role", "necessity", "content", "accounting",
  ]);
  if (!isRole(input.role)) throw new TypeError(`${path}.role is invalid.`);
  if (input.necessity !== "mandatory" && input.necessity !== "optional") {
    throw new TypeError(`${path}.necessity is invalid.`);
  }
  strictRecord(input.accounting, `${path}.accounting`, ["unit", "amount"]);
  if (input.accounting.unit !== unit) {
    throw new TypeError(`${path}.accounting must use the composition unit.`);
  }
  return Object.freeze({
    id: token(input.id, `${path}.id`),
    source: snapshotSource(input.source, `${path}.source`),
    kind: token(input.kind, `${path}.kind`),
    role: input.role,
    necessity: input.necessity,
    content: snapshotContent(input.content, `${path}.content`),
    accounting: Object.freeze({
      unit,
      amount: nonNegativeInteger(input.accounting.amount, `${path}.accounting.amount`),
    }),
  });
}

function snapshotContent(input: ModelInputContent, path: string): ModelInputContent {
  strictRecord(input, path, ["kind", "text", "value", "message"]);
  if (input.kind === "text") {
    strictRecord(input, path, ["kind", "text"]);
    if (typeof input.text !== "string") throw new TypeError(`${path}.text must be a string.`);
    return Object.freeze({ kind: "text", text: input.text });
  }
  if (input.kind === "structured") {
    strictRecord(input, path, ["kind", "value"]);
    return Object.freeze({
      kind: "structured",
      value: snapshotJsonValue(input.value, `${path}.value`),
    });
  }
  if (input.kind === "model_message") {
    strictRecord(input, path, ["kind", "message"]);
    return Object.freeze({
      kind: "model_message",
      message: snapshotModelMessages([input.message])[0]!,
    });
  }
  throw new TypeError(`${path}.kind is invalid.`);
}

function snapshotLineage(input: ModelInputLineage): ModelInputLineage {
  strictRecord(input, "ModelInputComposition.lineage", [
    "instructionBinding", "agent", "instructions", "instructionRelease",
    "instructionResolver", "instructionContent", "instructionModel", "instructionBlocks",
    "activeContext", "contextProjection", "projectionManifest", "toolSelection",
    "toolExposureContent", "toolExposureBasis", "toolExposureProof", "toolGuidance",
    "controllerControlGuidance", "callableDefinitions", "modelQualification",
    "interactionHistory",
    "protocol", "policy",
  ]);
  return Object.freeze({
    instructionBinding: snapshotSource(input.instructionBinding, "ModelInputComposition.lineage.instructionBinding"),
    agent: snapshotSource(input.agent, "ModelInputComposition.lineage.agent"),
    instructions: snapshotSource(input.instructions, "ModelInputComposition.lineage.instructions"),
    instructionRelease: snapshotSource(input.instructionRelease, "ModelInputComposition.lineage.instructionRelease"),
    instructionResolver: snapshotSource(input.instructionResolver, "ModelInputComposition.lineage.instructionResolver"),
    instructionContent: snapshotSource(input.instructionContent, "ModelInputComposition.lineage.instructionContent"),
    instructionModel: snapshotInstructionModel(input.instructionModel),
    instructionBlocks: snapshotSourceList(
      input.instructionBlocks,
      "ModelInputComposition.lineage.instructionBlocks",
    ),
    activeContext: snapshotNullableSource(input.activeContext, "ModelInputComposition.lineage.activeContext"),
    contextProjection: snapshotNullableSource(input.contextProjection, "ModelInputComposition.lineage.contextProjection"),
    projectionManifest: snapshotNullableSource(input.projectionManifest, "ModelInputComposition.lineage.projectionManifest"),
    toolSelection: snapshotNullableSource(input.toolSelection, "ModelInputComposition.lineage.toolSelection"),
    toolExposureContent: snapshotNullableSource(input.toolExposureContent, "ModelInputComposition.lineage.toolExposureContent"),
    toolExposureBasis: snapshotNullableSource(input.toolExposureBasis, "ModelInputComposition.lineage.toolExposureBasis"),
    toolExposureProof: snapshotNullableSource(input.toolExposureProof, "ModelInputComposition.lineage.toolExposureProof"),
    toolGuidance: snapshotNullableSource(input.toolGuidance, "ModelInputComposition.lineage.toolGuidance"),
    controllerControlGuidance: snapshotNullableSource(input.controllerControlGuidance, "ModelInputComposition.lineage.controllerControlGuidance"),
    callableDefinitions: snapshotNullableSource(input.callableDefinitions, "ModelInputComposition.lineage.callableDefinitions"),
    modelQualification: snapshotNullableSource(input.modelQualification, "ModelInputComposition.lineage.modelQualification"),
    interactionHistory: snapshotNullableSource(input.interactionHistory, "ModelInputComposition.lineage.interactionHistory"),
    protocol: snapshotSource(input.protocol, "ModelInputComposition.lineage.protocol"),
    policy: snapshotSource(input.policy, "ModelInputComposition.lineage.policy"),
  });
}

function snapshotInstructionModel(
  input: ModelInputLineage["instructionModel"],
): ModelInputLineage["instructionModel"] {
  strictRecord(input, "ModelInputComposition.lineage.instructionModel", ["providerId", "model"]);
  return Object.freeze({
    providerId: token(input.providerId, "ModelInputComposition.lineage.instructionModel.providerId"),
    model: token(input.model, "ModelInputComposition.lineage.instructionModel.model"),
  });
}

function snapshotSourceList(
  input: readonly ModelInputSourceRef[],
  path: string,
): readonly ModelInputSourceRef[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(`${path} must be a non-empty array.`);
  }
  return Object.freeze(input.map((source, index) => snapshotSource(source, `${path}[${index}]`)));
}

function snapshotNullableSource(input: ModelInputSourceRef | null, path: string): ModelInputSourceRef | null {
  return input === null ? null : snapshotSource(input, path);
}

function snapshotSource(input: ModelInputSourceRef, path: string): ModelInputSourceRef {
  strictRecord(input, path, ["owner", "kind", "id", "revision"]);
  return Object.freeze({
    owner: token(input.owner, `${path}.owner`),
    kind: token(input.kind, `${path}.kind`),
    id: token(input.id, `${path}.id`),
    revision: nullableToken(input.revision, `${path}.revision`),
  });
}

function isUnit(value: unknown): value is ModelInputUnit {
  return value === "bytes" || value === "tokens";
}

function isRole(value: unknown): value is ModelInputSectionRole {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

export function modelMessagesFromSections(
  sections: readonly ModelInputSection[],
): readonly ModelMessage[] {
  return Object.freeze(sections.map((section) => {
    if (section.content.kind === "model_message") {
      if (section.content.message.role !== section.role) {
        throw new TypeError("Model input message content role must match its section role.");
      }
      return section.content.message;
    }
    if (section.role === "tool") {
      throw new TypeError("Tool model-input sections require correlated result blocks.");
    }
    const text = section.content.kind === "text"
      ? section.content.text
      : JSON.stringify(section.content.value);
    return snapshotModelMessages([{
      role: section.role,
      content: [{ kind: "text", text }],
    } as ModelMessage])[0]!;
  }));
}
