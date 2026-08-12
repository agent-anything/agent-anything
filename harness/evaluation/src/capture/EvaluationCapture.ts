import {
  assertSafeProjectionData,
  compareText,
  snapshotEvaluationData,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
  type EvaluationDataValue,
} from "../contract/EvaluationData.js";
import {
  assertArray,
  assertIsoTime,
  assertPositiveInteger,
  assertText,
  assertToken,
  createEvaluationFailure,
  createEvaluationRecordRef,
  createEvaluationSchemaRef,
  evaluationRefKey,
  sensitivityRank,
  snapshotLimitations,
  type EvaluationFailure,
  type EvaluationLimitation,
  type EvaluationRecordRef,
  type EvaluationSchemaRef,
  type EvaluationSensitivity,
} from "../contract/EvaluationPrimitives.js";

export type EvaluationCaptureRetention =
  | "ephemeral"
  | "campaign"
  | "report"
  | "baseline";

export type EvaluationCaptureConsumerKind = "grader" | "metric";

export interface EvaluationCaptureConsumerRef {
  readonly kind: EvaluationCaptureConsumerKind;
  readonly ref: EvaluationRecordRef;
}

export interface EvaluationCaptureSlotDescriptor {
  readonly id: string;
  readonly owner: string;
  readonly schemaRef: EvaluationSchemaRef;
  readonly required: boolean;
  readonly maximumSensitivity: EvaluationSensitivity;
  readonly contentMode: "inline" | "reference";
  readonly retention: EvaluationCaptureRetention;
  readonly maximumBytes: number;
  readonly optionalOmission: "complete" | "partial";
  readonly consumers: readonly EvaluationCaptureConsumerRef[];
}

export interface EvaluationCapturePolicy {
  readonly ref: EvaluationRecordRef;
  readonly slots: readonly EvaluationCaptureSlotDescriptor[];
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export type EvaluationCaptureSlotStatus =
  | "captured"
  | "missing"
  | "unavailable"
  | "invalid"
  | "redacted";

export interface EvaluationCaptureReason {
  readonly code: string;
  readonly message: string;
  readonly sourceOwner: string;
  readonly details: EvaluationDataObject;
}

export type EvaluationCaptureContent =
  | { readonly kind: "inline"; readonly value: EvaluationDataValue }
  | { readonly kind: "reference"; readonly ref: EvaluationRecordRef };

export interface EvaluationCaptureContribution {
  readonly slotId: string;
  readonly owner: string;
  readonly schemaRef: EvaluationSchemaRef;
  readonly sensitivity: EvaluationSensitivity;
  readonly status: EvaluationCaptureSlotStatus;
  readonly content: EvaluationCaptureContent | null;
  readonly reason: EvaluationCaptureReason | null;
}

export interface EvaluationCaptureSlot extends EvaluationCaptureContribution {
  readonly required: boolean;
  readonly retention: EvaluationCaptureRetention;
  readonly consumers: readonly EvaluationCaptureConsumerRef[];
}

export interface EvaluationMeasurement {
  readonly id: string;
  readonly owner: string;
  readonly source: string;
  readonly unit: string;
  readonly value: number;
  readonly valid: boolean;
  readonly limitation: EvaluationLimitation | null;
}

export interface EvaluationCapture {
  readonly ref: EvaluationRecordRef;
  readonly trialRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly policyRef: EvaluationRecordRef;
  readonly environmentRef: EvaluationRecordRef;
  readonly status: "complete" | "partial" | "failed";
  readonly slots: readonly EvaluationCaptureSlot[];
  readonly measurements: readonly EvaluationMeasurement[];
  readonly missingData: readonly EvaluationCaptureSlot[];
  readonly sensitivities: readonly EvaluationSensitivity[];
  readonly retentions: readonly EvaluationCaptureRetention[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly failures: readonly EvaluationFailure[];
  readonly limitations: readonly EvaluationLimitation[];
  readonly metadata: EvaluationDataObject;
}

export interface EvaluationCaptureAssemblyInput {
  readonly ref: EvaluationRecordRef;
  readonly trialRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly policy: EvaluationCapturePolicy;
  readonly environmentRef: EvaluationRecordRef;
  readonly contributions: readonly EvaluationCaptureContribution[];
  readonly measurements: readonly EvaluationMeasurement[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly limitations: readonly EvaluationLimitation[];
  readonly metadata: EvaluationDataObject;
}

export interface EvaluationCaptureAssemblyResult {
  readonly status: "captured" | "partial" | "failed";
  readonly capture: EvaluationCapture;
}

export interface EvaluationCaptureRequest {
  readonly captureRef: EvaluationRecordRef;
  readonly trialRef: EvaluationRecordRef;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly policyRef: EvaluationRecordRef;
  readonly environmentRef: EvaluationRecordRef;
  readonly targetObservationRef: EvaluationRecordRef;
  readonly signal: AbortSignal;
  readonly deadlineAt: string | null;
}

export interface EvaluationCapturePort {
  capture(request: EvaluationCaptureRequest): Promise<EvaluationCaptureAssemblyResult>;
}

export interface EvaluationCaptureProjection {
  readonly ref: EvaluationRecordRef;
  readonly trialRef: EvaluationRecordRef;
  readonly status: EvaluationCapture["status"];
  readonly slots: readonly {
    readonly id: string;
    readonly owner: string;
    readonly schemaRef: EvaluationSchemaRef;
    readonly status: EvaluationCaptureSlotStatus;
    readonly contentRef: EvaluationRecordRef | null;
  }[];
  readonly measurementIds: readonly string[];
  readonly missingSlotIds: readonly string[];
  readonly limitations: readonly EvaluationLimitation[];
}

export function createEvaluationCapturePolicy(
  input: EvaluationCapturePolicy,
): EvaluationCapturePolicy {
  const ref = createEvaluationRecordRef(input?.ref, "EvaluationCapturePolicy.ref");
  assertArray(input.slots, "EvaluationCapturePolicy.slots");
  if (input.slots.length === 0) {
    throw new TypeError("EvaluationCapturePolicy.slots must not be empty.");
  }
  const seen = new Set<string>();
  const slots = input.slots.map((slot, index) => {
    const path = `EvaluationCapturePolicy.slots[${index}]`;
    assertToken(slot?.id, `${path}.id`);
    if (seen.has(slot.id)) throw new TypeError(`Capture slot '${slot.id}' is duplicated.`);
    seen.add(slot.id);
    assertToken(slot.owner, `${path}.owner`);
    if (typeof slot.required !== "boolean") throw new TypeError(`${path}.required must be boolean.`);
    assertSensitivity(slot.maximumSensitivity, `${path}.maximumSensitivity`);
    if (slot.contentMode !== "inline" && slot.contentMode !== "reference") {
      throw new TypeError(`${path}.contentMode is unsupported.`);
    }
    assertRetention(slot.retention, `${path}.retention`);
    assertPositiveInteger(slot.maximumBytes, `${path}.maximumBytes`);
    if (slot.optionalOmission !== "complete" && slot.optionalOmission !== "partial") {
      throw new TypeError(`${path}.optionalOmission is unsupported.`);
    }
    if (slot.required && slot.optionalOmission !== "complete") {
      throw new TypeError(`${path}.optionalOmission applies only to optional slots.`);
    }
    const consumers = snapshotConsumers(slot.consumers, `${path}.consumers`);
    return Object.freeze({
      id: slot.id,
      owner: slot.owner,
      schemaRef: createEvaluationSchemaRef(slot.schemaRef, `${path}.schemaRef`),
      required: slot.required,
      maximumSensitivity: slot.maximumSensitivity,
      contentMode: slot.contentMode,
      retention: slot.retention,
      maximumBytes: slot.maximumBytes,
      optionalOmission: slot.optionalOmission,
      consumers,
    });
  });
  assertIsoTime(input.createdAt, "EvaluationCapturePolicy.createdAt");
  return Object.freeze({
    ref,
    slots: Object.freeze(slots.sort((left, right) => compareText(left.id, right.id))),
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationCapturePolicy.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationCapturePolicy.limitations"),
  });
}

export function assembleEvaluationCapture(
  input: EvaluationCaptureAssemblyInput,
): EvaluationCaptureAssemblyResult {
  const policy = createEvaluationCapturePolicy(input.policy);
  assertIsoTime(input.startedAt, "EvaluationCapture.startedAt");
  assertIsoTime(input.completedAt, "EvaluationCapture.completedAt");
  if (input.completedAt < input.startedAt) {
    throw new TypeError("EvaluationCapture completedAt precedes startedAt.");
  }
  assertArray(input.contributions, "EvaluationCapture.contributions");
  const contributionGroups = new Map<string, EvaluationCaptureContribution[]>();
  const unknownSlots: string[] = [];
  const descriptorIds = new Set(policy.slots.map((slot) => slot.id));
  for (const contribution of input.contributions) {
    if (!descriptorIds.has(contribution?.slotId)) {
      unknownSlots.push(String(contribution?.slotId));
      continue;
    }
    const group = contributionGroups.get(contribution.slotId) ?? [];
    group.push(contribution);
    contributionGroups.set(contribution.slotId, group);
  }

  const failures: EvaluationFailure[] = [];
  if (unknownSlots.length > 0) {
    failures.push(captureFailure("Capture adapter contributed undeclared slots.", {
      slotIds: Object.freeze([...unknownSlots].sort(compareText)),
    }));
  }
  const slots = policy.slots.map((descriptor) => {
    const contributions = contributionGroups.get(descriptor.id) ?? [];
    if (contributions.length === 0) return missingSlot(descriptor);
    if (contributions.length > 1) {
      failures.push(captureFailure(`Capture slot '${descriptor.id}' was contributed more than once.`, {
        slotId: descriptor.id,
      }));
      return invalidSlot(descriptor, "duplicate_contribution", "Slot was contributed more than once.");
    }
    try {
      return snapshotContribution(contributions[0], descriptor);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Capture contribution is invalid.";
      failures.push(captureFailure(message, { slotId: descriptor.id }));
      return invalidSlot(descriptor, "invalid_contribution", message);
    }
  });
  const measurements = snapshotMeasurements(input.measurements);
  const missingData = Object.freeze(slots.filter((slot) => slot.status !== "captured"));
  const requiredFailure = slots.some((slot) => slot.required && slot.status !== "captured");
  if (requiredFailure && !failures.some((failure) => failure.code === "evaluation_capture_failed")) {
    failures.push(captureFailure("One or more mandatory Capture slots did not settle as captured.", {}));
  }
  const optionalPartial = slots.some((slot) => {
    const descriptor = policy.slots.find((candidate) => candidate.id === slot.slotId);
    return !slot.required && slot.status !== "captured" && descriptor?.optionalOmission === "partial";
  });
  const status: EvaluationCapture["status"] = requiredFailure || unknownSlots.length > 0
    ? "failed"
    : optionalPartial
      ? "partial"
      : "complete";
  const metadata = snapshotEvaluationDataObject(
    input.metadata,
    "EvaluationCapture.metadata",
  );
  assertSafeProjectionData(metadata, "EvaluationCapture.metadata");
  const capture = Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationCapture.ref"),
    trialRef: createEvaluationRecordRef(input.trialRef, "EvaluationCapture.trialRef"),
    targetSnapshotRef: createEvaluationRecordRef(
      input.targetSnapshotRef,
      "EvaluationCapture.targetSnapshotRef",
    ),
    caseRef: createEvaluationRecordRef(input.caseRef, "EvaluationCapture.caseRef"),
    policyRef: policy.ref,
    environmentRef: createEvaluationRecordRef(
      input.environmentRef,
      "EvaluationCapture.environmentRef",
    ),
    status,
    slots: Object.freeze(slots),
    measurements,
    missingData,
    sensitivities: uniqueSorted(slots.map((slot) => slot.sensitivity)),
    retentions: uniqueSorted(slots.map((slot) => slot.retention)),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    failures: Object.freeze(failures),
    limitations: snapshotLimitations(input.limitations, "EvaluationCapture.limitations"),
    metadata,
  }) satisfies EvaluationCapture;
  return Object.freeze({
    status: status === "complete" ? "captured" : status,
    capture,
  });
}

export function projectEvaluationCapture(
  capture: EvaluationCapture,
): EvaluationCaptureProjection {
  return Object.freeze({
    ref: capture.ref,
    trialRef: capture.trialRef,
    status: capture.status,
    slots: Object.freeze(capture.slots.map((slot) => Object.freeze({
      id: slot.slotId,
      owner: slot.owner,
      schemaRef: slot.schemaRef,
      status: slot.status,
      contentRef: slot.content?.kind === "reference" ? slot.content.ref : null,
    }))),
    measurementIds: Object.freeze(capture.measurements.map((item) => item.id)),
    missingSlotIds: Object.freeze(capture.missingData.map((item) => item.slotId)),
    limitations: capture.limitations,
  });
}

function snapshotContribution(
  input: EvaluationCaptureContribution,
  descriptor: EvaluationCaptureSlotDescriptor,
): EvaluationCaptureSlot {
  assertToken(input?.slotId, "EvaluationCaptureContribution.slotId");
  assertToken(input.owner, "EvaluationCaptureContribution.owner");
  if (input.owner !== descriptor.owner) throw new TypeError("Capture contribution owner does not match policy.");
  const schemaRef = createEvaluationSchemaRef(input.schemaRef, "EvaluationCaptureContribution.schemaRef");
  if (
    schemaRef.schemaId !== descriptor.schemaRef.schemaId ||
    schemaRef.revision !== descriptor.schemaRef.revision
  ) throw new TypeError("Capture contribution schema does not match policy.");
  assertSensitivity(input.sensitivity, "EvaluationCaptureContribution.sensitivity");
  if (sensitivityRank(input.sensitivity) > sensitivityRank(descriptor.maximumSensitivity)) {
    throw new TypeError("Capture contribution exceeds admitted sensitivity.");
  }
  assertSlotStatus(input.status);
  const content = snapshotContent(input.content, input.status, descriptor);
  const reason = snapshotReason(input.reason, input.status);
  return Object.freeze({
    slotId: descriptor.id,
    owner: descriptor.owner,
    schemaRef,
    sensitivity: input.sensitivity,
    status: input.status,
    content,
    reason,
    required: descriptor.required,
    retention: descriptor.retention,
    consumers: descriptor.consumers,
  });
}

function snapshotContent(
  input: EvaluationCaptureContent | null,
  status: EvaluationCaptureSlotStatus,
  descriptor: EvaluationCaptureSlotDescriptor,
): EvaluationCaptureContent | null {
  if (status !== "captured") {
    if (input !== null) throw new TypeError("Non-captured slot must not carry content.");
    return null;
  }
  if (input === null || input.kind !== descriptor.contentMode) {
    throw new TypeError("Captured slot content does not match policy mode.");
  }
  if (input.kind === "reference") {
    return Object.freeze({
      kind: "reference",
      ref: createEvaluationRecordRef(input.ref, "EvaluationCaptureContent.ref"),
    });
  }
  const value = snapshotEvaluationData(input.value, "EvaluationCaptureContent.value");
  assertSafeProjectionData(value, "EvaluationCaptureContent.value");
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > descriptor.maximumBytes) {
    throw new TypeError(`Capture slot '${descriptor.id}' exceeds its byte limit.`);
  }
  return Object.freeze({ kind: "inline", value });
}

function snapshotReason(
  input: EvaluationCaptureReason | null,
  status: EvaluationCaptureSlotStatus,
): EvaluationCaptureReason | null {
  if (status === "captured") {
    if (input !== null) throw new TypeError("Captured slot must not carry a missing-data reason.");
    return null;
  }
  if (input === null) throw new TypeError("Non-captured slot requires a reason.");
  assertToken(input.code, "EvaluationCaptureReason.code");
  assertText(input.message, "EvaluationCaptureReason.message", 1_024);
  assertToken(input.sourceOwner, "EvaluationCaptureReason.sourceOwner");
  const details = snapshotEvaluationDataObject(
    input.details,
    "EvaluationCaptureReason.details",
  );
  assertSafeProjectionData(details, "EvaluationCaptureReason.details");
  return Object.freeze({
    code: input.code,
    message: input.message,
    sourceOwner: input.sourceOwner,
    details,
  });
}

function snapshotMeasurements(
  input: readonly EvaluationMeasurement[],
): readonly EvaluationMeasurement[] {
  assertArray(input, "EvaluationCapture.measurements");
  const seen = new Set<string>();
  const result = input.map((measurement, index) => {
    const path = `EvaluationCapture.measurements[${index}]`;
    assertToken(measurement?.id, `${path}.id`);
    if (seen.has(measurement.id)) throw new TypeError(`Measurement '${measurement.id}' is duplicated.`);
    seen.add(measurement.id);
    assertToken(measurement.owner, `${path}.owner`);
    assertToken(measurement.source, `${path}.source`);
    assertToken(measurement.unit, `${path}.unit`);
    if (!Number.isFinite(measurement.value)) throw new TypeError(`${path}.value must be finite.`);
    if (typeof measurement.valid !== "boolean") throw new TypeError(`${path}.valid must be boolean.`);
    const limitation = measurement.limitation === null
      ? null
      : snapshotLimitations([measurement.limitation], `${path}.limitation`)[0];
    if (!measurement.valid && limitation === null) {
      throw new TypeError(`${path} requires a limitation when invalid.`);
    }
    return Object.freeze({ ...measurement, limitation });
  });
  return Object.freeze(result.sort((left, right) => compareText(left.id, right.id)));
}

function missingSlot(descriptor: EvaluationCaptureSlotDescriptor): EvaluationCaptureSlot {
  return Object.freeze({
    slotId: descriptor.id,
    owner: descriptor.owner,
    schemaRef: descriptor.schemaRef,
    sensitivity: "public",
    status: "missing",
    content: null,
    reason: Object.freeze({
      code: "capture_source_missing",
      message: "The declared source supplied no contribution.",
      sourceOwner: descriptor.owner,
      details: Object.freeze({}),
    }),
    required: descriptor.required,
    retention: descriptor.retention,
    consumers: descriptor.consumers,
  });
}

function invalidSlot(
  descriptor: EvaluationCaptureSlotDescriptor,
  code: string,
  message: string,
): EvaluationCaptureSlot {
  return Object.freeze({
    slotId: descriptor.id,
    owner: descriptor.owner,
    schemaRef: descriptor.schemaRef,
    sensitivity: "public",
    status: "invalid",
    content: null,
    reason: Object.freeze({
      code,
      message,
      sourceOwner: descriptor.owner,
      details: Object.freeze({}),
    }),
    required: descriptor.required,
    retention: descriptor.retention,
    consumers: descriptor.consumers,
  });
}

function captureFailure(message: string, details: EvaluationDataObject): EvaluationFailure {
  return createEvaluationFailure({
    code: "evaluation_capture_failed",
    stage: "capture",
    message,
    retryable: false,
    causeOwner: "evaluation.capture",
    details,
  });
}

function snapshotConsumers(
  input: readonly EvaluationCaptureConsumerRef[],
  path: string,
): readonly EvaluationCaptureConsumerRef[] {
  assertArray(input, path);
  const seen = new Set<string>();
  const result = input.map((consumer, index) => {
    if (consumer?.kind !== "grader" && consumer?.kind !== "metric") {
      throw new TypeError(`${path}[${index}].kind is unsupported.`);
    }
    const ref = createEvaluationRecordRef(consumer.ref, `${path}[${index}].ref`);
    const key = `${consumer.kind}:${evaluationRefKey(ref)}`;
    if (seen.has(key)) throw new TypeError(`${path} contains duplicate consumer '${key}'.`);
    seen.add(key);
    return Object.freeze({ kind: consumer.kind, ref });
  });
  return Object.freeze(result.sort((left, right) =>
    compareText(`${left.kind}:${evaluationRefKey(left.ref)}`, `${right.kind}:${evaluationRefKey(right.ref)}`)));
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function assertSlotStatus(value: EvaluationCaptureSlotStatus): void {
  if (!(["captured", "missing", "unavailable", "invalid", "redacted"] as const).includes(value)) {
    throw new TypeError("EvaluationCaptureContribution.status is unsupported.");
  }
}

function assertSensitivity(value: EvaluationSensitivity, path: string): void {
  if (!(["public", "internal", "confidential", "restricted"] as const).includes(value)) {
    throw new TypeError(`${path} is unsupported.`);
  }
}

function assertRetention(value: EvaluationCaptureRetention, path: string): void {
  if (!(["ephemeral", "campaign", "report", "baseline"] as const).includes(value)) {
    throw new TypeError(`${path} is unsupported.`);
  }
}
