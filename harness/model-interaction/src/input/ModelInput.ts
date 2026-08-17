import type { ModelJsonValue } from "../ModelInteractionContractValidation.js";
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

export type ModelInputContent =
  | ModelInputTextContent
  | ModelInputStructuredContent;

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
  readonly activeContext: ModelInputSourceRef | null;
  readonly contextProjection: ModelInputSourceRef | null;
  readonly projectionManifest: ModelInputSourceRef | null;
  readonly toolExposure: ModelInputSourceRef | null;
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
  readonly framing: ModelInputFraming;
  readonly contextBudget: {
    readonly unit: ModelInputUnit;
    readonly amount: number;
  };
  readonly sections: readonly ModelInputSection[];
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
    "id", "providerId", "model", "estimator", "limit", "outputReserve",
    "framing", "contextBudget", "sections", "lineage", "accounting",
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
  const sectionAmount = sections.reduce(
    (total, section) => total + section.accounting.amount,
    0,
  );
  const inputAmount = framing.amount + sectionAmount;
  const remainingAmount = limit.maximum - inputAmount - outputReserve.amount;
  if (remainingAmount < 0) {
    throw new TypeError("ModelInputComposition exceeds the model input limit.");
  }
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
    framing,
    contextBudget,
    sections: Object.freeze(sections),
    lineage: snapshotLineage(input.lineage),
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
  strictRecord(input, path, ["kind", "text", "value"]);
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
  throw new TypeError(`${path}.kind is invalid.`);
}

function snapshotLineage(input: ModelInputLineage): ModelInputLineage {
  strictRecord(input, "ModelInputComposition.lineage", [
    "activeContext", "contextProjection", "projectionManifest", "toolExposure",
    "protocol", "policy",
  ]);
  return Object.freeze({
    activeContext: snapshotNullableSource(input.activeContext, "ModelInputComposition.lineage.activeContext"),
    contextProjection: snapshotNullableSource(input.contextProjection, "ModelInputComposition.lineage.contextProjection"),
    projectionManifest: snapshotNullableSource(input.projectionManifest, "ModelInputComposition.lineage.projectionManifest"),
    toolExposure: snapshotNullableSource(input.toolExposure, "ModelInputComposition.lineage.toolExposure"),
    protocol: snapshotSource(input.protocol, "ModelInputComposition.lineage.protocol"),
    policy: snapshotSource(input.policy, "ModelInputComposition.lineage.policy"),
  });
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
