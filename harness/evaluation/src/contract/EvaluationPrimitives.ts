import {
  assertSafeProjectionData,
  contractError,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
} from "./EvaluationData.js";

export interface EvaluationRecordRef {
  readonly id: string;
  readonly revision: string;
}

export interface EvaluationSchemaRef {
  readonly schemaId: string;
  readonly revision: string;
}

export interface EvaluationValidity {
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface EvaluationLimitation {
  readonly code: string;
  readonly message: string;
  readonly metadata: EvaluationDataObject;
}

export interface EvaluationProvenance {
  readonly source: string;
  readonly sourceRevision: string;
  readonly license: string | null;
  readonly metadata: EvaluationDataObject;
}

export type EvaluationSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type EvaluationDisclosure = "public" | "internal" | "restricted";

export type EvaluationFailureStage =
  | "definition"
  | "environment"
  | "invocation"
  | "capture"
  | "grading"
  | "metric"
  | "report"
  | "persistence"
  | "cancellation"
  | "timeout"
  | "cleanup";

export type EvaluationFailureCode =
  | "evaluation_definition_invalid"
  | "evaluation_target_snapshot_invalid"
  | "evaluation_case_invalid"
  | "evaluation_suite_invalid"
  | "evaluation_protocol_invalid"
  | "evaluation_environment_failed"
  | "evaluation_invocation_failed"
  | "evaluation_capture_failed"
  | "evaluation_grader_invalid"
  | "evaluation_grader_unavailable"
  | "evaluation_grader_failed"
  | "evaluation_metric_invalid"
  | "evaluation_report_failed"
  | "evaluation_persistence_failed"
  | "evaluation_cancelled"
  | "evaluation_timed_out"
  | "evaluation_cleanup_failed";

export interface EvaluationFailure {
  readonly code: EvaluationFailureCode;
  readonly stage: EvaluationFailureStage;
  readonly message: string;
  readonly retryable: boolean;
  readonly causeOwner: string | null;
  readonly details: EvaluationDataObject;
}

const FAILURE_STAGE: Readonly<Record<EvaluationFailureCode, EvaluationFailureStage>> =
  Object.freeze({
    evaluation_definition_invalid: "definition",
    evaluation_target_snapshot_invalid: "definition",
    evaluation_case_invalid: "definition",
    evaluation_suite_invalid: "definition",
    evaluation_protocol_invalid: "definition",
    evaluation_environment_failed: "environment",
    evaluation_invocation_failed: "invocation",
    evaluation_capture_failed: "capture",
    evaluation_grader_invalid: "grading",
    evaluation_grader_unavailable: "grading",
    evaluation_grader_failed: "grading",
    evaluation_metric_invalid: "metric",
    evaluation_report_failed: "report",
    evaluation_persistence_failed: "persistence",
    evaluation_cancelled: "cancellation",
    evaluation_timed_out: "timeout",
    evaluation_cleanup_failed: "cleanup",
  });

export function createEvaluationRecordRef(
  input: EvaluationRecordRef,
  path = "EvaluationRecordRef",
): EvaluationRecordRef {
  assertToken(input?.id, `${path}.id`);
  assertRevision(input?.revision, `${path}.revision`);
  return Object.freeze({ id: input.id, revision: input.revision });
}

export function createEvaluationSchemaRef(
  input: EvaluationSchemaRef,
  path = "EvaluationSchemaRef",
): EvaluationSchemaRef {
  assertToken(input?.schemaId, `${path}.schemaId`);
  assertRevision(input?.revision, `${path}.revision`);
  return Object.freeze({ schemaId: input.schemaId, revision: input.revision });
}

export function createEvaluationFailure(
  input: EvaluationFailure,
): EvaluationFailure {
  const expectedStage = FAILURE_STAGE[input?.code];
  if (expectedStage === undefined || input.stage !== expectedStage) {
    throw contractError(
      "evaluation_definition_invalid",
      "EvaluationFailure code and stage do not agree.",
      "EvaluationFailure.stage",
    );
  }
  assertText(input.message, "EvaluationFailure.message", 1_024);
  if (typeof input.retryable !== "boolean") {
    throw contractError(
      "evaluation_definition_invalid",
      "EvaluationFailure.retryable must be boolean.",
      "EvaluationFailure.retryable",
    );
  }
  if (input.causeOwner !== null) {
    assertToken(input.causeOwner, "EvaluationFailure.causeOwner");
  }
  const details = snapshotEvaluationDataObject(input.details, "EvaluationFailure.details");
  assertSafeProjectionData(details, "EvaluationFailure.details");
  return Object.freeze({
    code: input.code,
    stage: input.stage,
    message: input.message,
    retryable: input.retryable,
    causeOwner: input.causeOwner,
    details,
  });
}

export function snapshotValidity(
  input: EvaluationValidity,
  path: string,
): EvaluationValidity {
  if (input.validFrom !== null) assertIsoTime(input.validFrom, `${path}.validFrom`);
  if (input.validUntil !== null) assertIsoTime(input.validUntil, `${path}.validUntil`);
  if (
    input.validFrom !== null &&
    input.validUntil !== null &&
    input.validFrom > input.validUntil
  ) {
    throw contractError(
      "evaluation_definition_invalid",
      `${path} validFrom must not follow validUntil.`,
      path,
    );
  }
  return Object.freeze({ validFrom: input.validFrom, validUntil: input.validUntil });
}

export function snapshotLimitations(
  input: readonly EvaluationLimitation[],
  path: string,
): readonly EvaluationLimitation[] {
  assertArray(input, path);
  const seen = new Set<string>();
  return Object.freeze(input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    assertToken(item?.code, `${itemPath}.code`);
    if (seen.has(item.code)) {
      throw contractError(
        "evaluation_definition_invalid",
        `${path} contains duplicate limitation '${item.code}'.`,
        itemPath,
      );
    }
    seen.add(item.code);
    assertText(item.message, `${itemPath}.message`, 2_048);
    return Object.freeze({
      code: item.code,
      message: item.message,
      metadata: snapshotEvaluationDataObject(item.metadata, `${itemPath}.metadata`),
    });
  }));
}

export function snapshotProvenance(
  input: EvaluationProvenance,
  path: string,
): EvaluationProvenance {
  assertText(input?.source, `${path}.source`, 512);
  assertRevision(input.sourceRevision, `${path}.sourceRevision`);
  if (input.license !== null) assertText(input.license, `${path}.license`, 512);
  return Object.freeze({
    source: input.source,
    sourceRevision: input.sourceRevision,
    license: input.license,
    metadata: snapshotEvaluationDataObject(input.metadata, `${path}.metadata`),
  });
}

export function isEvaluationRefEqual(
  left: EvaluationRecordRef,
  right: EvaluationRecordRef,
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function evaluationRefKey(ref: EvaluationRecordRef): string {
  return `${ref.id}@${ref.revision}`;
}

export function assertUniqueRefs(
  refs: readonly EvaluationRecordRef[],
  path: string,
): void {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    const key = evaluationRefKey(ref);
    if (seen.has(key)) {
      throw contractError(
        "evaluation_definition_invalid",
        `${path} contains duplicate ref '${key}'.`,
        `${path}[${index}]`,
      );
    }
    seen.add(key);
  });
}

export function snapshotRefs(
  refs: readonly EvaluationRecordRef[],
  path: string,
): readonly EvaluationRecordRef[] {
  assertArray(refs, path);
  const result = refs.map((ref, index) =>
    createEvaluationRecordRef(ref, `${path}[${index}]`));
  assertUniqueRefs(result, path);
  return Object.freeze(result);
}

export function assertToken(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    throw contractError(
      "evaluation_identity_invalid",
      `${path} must be a canonical non-empty token.`,
      path,
    );
  }
}

export function assertRevision(value: unknown, path: string): asserts value is string {
  try {
    assertToken(value, path);
  } catch {
    throw contractError(
      "evaluation_revision_invalid",
      `${path} must be a canonical revision.`,
      path,
    );
  }
}

export function assertText(
  value: unknown,
  path: string,
  maximumLength = 8_192,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw contractError(
      "evaluation_definition_invalid",
      `${path} must be non-empty bounded text.`,
      path,
    );
  }
}

export function assertIsoTime(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw contractError(
      "evaluation_time_invalid",
      `${path} must be an ISO date-time string.`,
      path,
    );
  }
}

export function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw contractError(
      "evaluation_definition_invalid",
      `${path} must be an array.`,
      path,
    );
  }
}

export function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw contractError(
      "evaluation_definition_invalid",
      `${path} must be a positive safe integer.`,
      path,
    );
  }
}

export function sensitivityRank(value: EvaluationSensitivity): number {
  switch (value) {
    case "public": return 0;
    case "internal": return 1;
    case "confidential": return 2;
    case "restricted": return 3;
  }
}
