import { createHash } from "node:crypto";
import type { ModelInputComposition } from "../input/index.js";

export interface ProviderModelTarget {
  readonly providerId: string;
  readonly model: string;
  readonly revision: string;
}

export type ModelContextCapacity =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly unit: "tokens";
      readonly maximum: number;
      readonly semantics: "input_and_output" | "input_only";
      readonly source: "provider_reported" | "host_configured";
      readonly providerId: string;
      readonly model: string;
      readonly revision: string;
    };

export interface ProviderRequestedOutput {
  readonly unit: "tokens";
  readonly maximum: number;
  readonly source: "product_configured" | "host_configured";
  readonly revision: string;
}

export interface ModelContextHeadroom {
  readonly unit: "tokens";
  readonly amount: number;
  readonly policy: {
    readonly id: string;
    readonly revision: string;
  };
}

export type ModelInputMeasuredAccuracy = "exact" | "upper_bound" | "estimated";

export interface ModelInputEstimatorRef {
  readonly id: string;
  readonly revision: string;
  readonly unit: "tokens";
  readonly accuracy: ModelInputMeasuredAccuracy;
}

export type ModelInputMeasurement =
  | {
      readonly status: "measured";
      readonly amount: number;
      readonly estimator: ModelInputEstimatorRef;
      readonly uncertainty:
        | { readonly kind: "none" }
        | { readonly kind: "bounded"; readonly maximumErrorTokens: number }
        | { readonly kind: "unquantified" };
      readonly measuredCompositionId: string;
      readonly measuredAt: string;
    }
  | {
      readonly status: "unknown";
      readonly unit: "tokens";
      readonly accuracy: "unknown";
      readonly estimator: ModelInputEstimatorRef | null;
      readonly reason: "unsupported" | "unavailable" | "not_authoritative";
      readonly measuredCompositionId: string;
      readonly measuredAt: string;
    };

export type ModelContextAssessmentDisposition =
  | "proven_fit"
  | "proven_overflow"
  | "estimated_fit"
  | "estimated_overflow"
  | "unresolved";

export interface ModelContextAssessment {
  readonly id: string;
  readonly revision: string;
  readonly compositionId: string;
  readonly capacity: ModelContextCapacity;
  readonly measurement: ModelInputMeasurement;
  readonly requestedOutput: ProviderRequestedOutput;
  readonly headroom: ModelContextHeadroom;
  readonly effectiveInputBudget: number | null;
  readonly disposition: ModelContextAssessmentDisposition;
  readonly assessedAt: string;
}

export type ProviderInputTransformationDisposition =
  | "disabled"
  | "reported_exactly"
  | "unknown";

export interface ProviderInputPreservationConformance {
  readonly providerId: string;
  readonly model: string;
  readonly adapterRevision: string;
  readonly runtimeVersion: string | null;
  readonly truncation: ProviderInputTransformationDisposition;
  readonly contextShift: ProviderInputTransformationDisposition;
  readonly evidence: readonly {
    readonly owner: string;
    readonly kind: string;
    readonly id: string;
    readonly revision: string | null;
  }[];
  readonly revision: string;
}

export interface ProviderModelContext {
  readonly target: ProviderModelTarget;
  readonly capacity: ModelContextCapacity;
  readonly requestedOutput: ProviderRequestedOutput;
  readonly inputPreservation: ProviderInputPreservationConformance;
  measure(
    composition: ModelInputComposition,
    measuredAt: string,
  ): ModelInputMeasurement;
}

export function createUnknownModelInputMeasurement(input: {
  readonly compositionId: string;
  readonly measuredAt: string;
  readonly reason: Extract<ModelInputMeasurement, { readonly status: "unknown" }>["reason"];
  readonly estimator?: ModelInputEstimatorRef | null;
}): ModelInputMeasurement {
  return Object.freeze({
    status: "unknown",
    unit: "tokens",
    accuracy: "unknown",
    estimator: input.estimator ?? null,
    reason: input.reason,
    measuredCompositionId: requiredText(input.compositionId, "compositionId"),
    measuredAt: isoDateTime(input.measuredAt, "measuredAt"),
  });
}

export function assessModelContext(input: {
  readonly compositionId: string;
  readonly capacity: ModelContextCapacity;
  readonly measurement: ModelInputMeasurement;
  readonly requestedOutput: ProviderRequestedOutput;
  readonly headroom: ModelContextHeadroom;
  readonly assessedAt: string;
  readonly revision: string;
}): ModelContextAssessment {
  const compositionId = requiredText(input.compositionId, "compositionId");
  const capacity = snapshotModelContextCapacity(input.capacity);
  const measurement = snapshotModelInputMeasurement(input.measurement, compositionId);
  const requestedOutput = snapshotProviderRequestedOutput(input.requestedOutput);
  const headroom = snapshotModelContextHeadroom(input.headroom);
  const assessedAt = isoDateTime(input.assessedAt, "assessedAt");
  const revision = requiredText(input.revision, "revision");

  let effectiveInputBudget: number | null = null;
  let disposition: ModelContextAssessmentDisposition = "unresolved";
  if (capacity.supported) {
    effectiveInputBudget = capacity.maximum - headroom.amount -
      (capacity.semantics === "input_and_output" ? requestedOutput.maximum : 0);
    if (effectiveInputBudget < 0) {
      disposition = "proven_overflow";
    } else if (measurement.status === "measured") {
      if (measurement.estimator.accuracy === "exact") {
        disposition = measurement.amount <= effectiveInputBudget
          ? "proven_fit"
          : "proven_overflow";
      } else if (measurement.estimator.accuracy === "upper_bound") {
        disposition = measurement.amount <= effectiveInputBudget
          ? "proven_fit"
          : "unresolved";
      } else {
        disposition = measurement.amount <= effectiveInputBudget
          ? "estimated_fit"
          : "estimated_overflow";
      }
    }
  }

  const basis = {
    compositionId,
    capacity,
    measurement,
    requestedOutput,
    headroom,
    effectiveInputBudget,
    disposition,
    assessedAt,
    revision,
  };
  return Object.freeze({
    id: digest("agent-anything.model-context-assessment.v1", basis),
    ...basis,
  });
}

export function snapshotModelContextCapacity(
  input: ModelContextCapacity,
): ModelContextCapacity {
  if (input.supported === false) return Object.freeze({ supported: false });
  if (input.supported !== true || input.unit !== "tokens") {
    throw new TypeError("Model Context capacity is invalid.");
  }
  return Object.freeze({
    supported: true,
    unit: "tokens",
    maximum: positiveInteger(input.maximum, "capacity.maximum"),
    semantics: oneOf(input.semantics, ["input_and_output", "input_only"], "capacity.semantics"),
    source: oneOf(input.source, ["provider_reported", "host_configured"], "capacity.source"),
    providerId: requiredText(input.providerId, "capacity.providerId"),
    model: requiredText(input.model, "capacity.model"),
    revision: requiredText(input.revision, "capacity.revision"),
  });
}

export function snapshotProviderModelTarget(
  input: ProviderModelTarget,
): ProviderModelTarget {
  return Object.freeze({
    providerId: requiredText(input.providerId, "target.providerId"),
    model: requiredText(input.model, "target.model"),
    revision: requiredText(input.revision, "target.revision"),
  });
}

export function snapshotProviderInputPreservationConformance(
  input: ProviderInputPreservationConformance,
): ProviderInputPreservationConformance {
  if (!Array.isArray(input.evidence)) {
    throw new TypeError("Provider input-preservation evidence must be an array.");
  }
  return Object.freeze({
    providerId: requiredText(input.providerId, "inputPreservation.providerId"),
    model: requiredText(input.model, "inputPreservation.model"),
    adapterRevision: requiredText(input.adapterRevision, "inputPreservation.adapterRevision"),
    runtimeVersion: input.runtimeVersion === null
      ? null
      : requiredText(input.runtimeVersion, "inputPreservation.runtimeVersion"),
    truncation: oneOf(
      input.truncation,
      ["disabled", "reported_exactly", "unknown"],
      "inputPreservation.truncation",
    ),
    contextShift: oneOf(
      input.contextShift,
      ["disabled", "reported_exactly", "unknown"],
      "inputPreservation.contextShift",
    ),
    evidence: Object.freeze(input.evidence.map((source, index) => Object.freeze({
      owner: requiredText(source.owner, `inputPreservation.evidence[${index}].owner`),
      kind: requiredText(source.kind, `inputPreservation.evidence[${index}].kind`),
      id: requiredText(source.id, `inputPreservation.evidence[${index}].id`),
      revision: source.revision === null
        ? null
        : requiredText(source.revision, `inputPreservation.evidence[${index}].revision`),
    }))),
    revision: requiredText(input.revision, "inputPreservation.revision"),
  });
}

export function snapshotProviderRequestedOutput(
  input: ProviderRequestedOutput,
): ProviderRequestedOutput {
  if (input.unit !== "tokens") throw new TypeError("Requested output must use tokens.");
  return Object.freeze({
    unit: "tokens",
    maximum: positiveInteger(input.maximum, "requestedOutput.maximum"),
    source: oneOf(input.source, ["product_configured", "host_configured"], "requestedOutput.source"),
    revision: requiredText(input.revision, "requestedOutput.revision"),
  });
}

export function snapshotModelContextHeadroom(
  input: ModelContextHeadroom,
): ModelContextHeadroom {
  if (input.unit !== "tokens") throw new TypeError("Context headroom must use tokens.");
  return Object.freeze({
    unit: "tokens",
    amount: nonNegativeInteger(input.amount, "headroom.amount"),
    policy: Object.freeze({
      id: requiredText(input.policy.id, "headroom.policy.id"),
      revision: requiredText(input.policy.revision, "headroom.policy.revision"),
    }),
  });
}

export function snapshotModelContextAssessment(
  input: ModelContextAssessment,
): ModelContextAssessment {
  const snapshot = assessModelContext({
    compositionId: input.compositionId,
    capacity: input.capacity,
    measurement: input.measurement,
    requestedOutput: input.requestedOutput,
    headroom: input.headroom,
    assessedAt: input.assessedAt,
    revision: input.revision,
  });
  if (snapshot.id !== input.id || snapshot.disposition !== input.disposition ||
      snapshot.effectiveInputBudget !== input.effectiveInputBudget) {
    throw new TypeError("Model Context assessment is inconsistent.");
  }
  return snapshot;
}

function snapshotModelInputMeasurement(
  input: ModelInputMeasurement,
  compositionId: string,
): ModelInputMeasurement {
  if (input.measuredCompositionId !== compositionId) {
    throw new TypeError("Model input measurement must target the assessed composition.");
  }
  if (input.status === "unknown") {
    return createUnknownModelInputMeasurement({
      compositionId,
      measuredAt: input.measuredAt,
      reason: oneOf(input.reason, ["unsupported", "unavailable", "not_authoritative"], "measurement.reason"),
      estimator: input.estimator === null ? null : snapshotEstimator(input.estimator),
    });
  }
  const estimator = snapshotEstimator(input.estimator);
  const uncertainty = input.uncertainty.kind === "none"
    ? Object.freeze({ kind: "none" as const })
    : input.uncertainty.kind === "unquantified"
      ? Object.freeze({ kind: "unquantified" as const })
      : Object.freeze({
          kind: "bounded" as const,
          maximumErrorTokens: nonNegativeInteger(
            input.uncertainty.maximumErrorTokens,
            "measurement.uncertainty.maximumErrorTokens",
          ),
        });
  if (estimator.accuracy === "exact" && uncertainty.kind !== "none") {
    throw new TypeError("Exact model input measurement cannot declare uncertainty.");
  }
  return Object.freeze({
    status: "measured",
    amount: nonNegativeInteger(input.amount, "measurement.amount"),
    estimator,
    uncertainty,
    measuredCompositionId: compositionId,
    measuredAt: isoDateTime(input.measuredAt, "measurement.measuredAt"),
  });
}

function snapshotEstimator(input: ModelInputEstimatorRef): ModelInputEstimatorRef {
  if (input.unit !== "tokens") throw new TypeError("Model input estimator must use tokens.");
  return Object.freeze({
    id: requiredText(input.id, "estimator.id"),
    revision: requiredText(input.revision, "estimator.revision"),
    unit: "tokens",
    accuracy: oneOf(input.accuracy, ["exact", "upper_bound", "estimated"], "estimator.accuracy"),
  });
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  throw new TypeError("Model Context digest input is invalid.");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty.`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function isoDateTime(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${field} must be an ISO timestamp.`);
  return text;
}

function oneOf<const T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new TypeError(`${field} is invalid.`);
  return value as T;
}
