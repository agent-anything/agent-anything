import type { EvaluationCapture } from "../capture/EvaluationCapture.js";
import {
  compareText,
  snapshotEvaluationDataObject,
  type EvaluationDataObject,
} from "../contract/EvaluationData.js";
import {
  runControlledOperation,
  type EvaluationDeadlinePort,
  type EvaluationOperationControl,
} from "../contract/ControlledOperation.js";
import {
  assertArray,
  assertIsoTime,
  assertText,
  assertToken,
  createEvaluationFailure,
  createEvaluationRecordRef,
  createEvaluationSchemaRef,
  evaluationRefKey,
  isEvaluationRefEqual,
  snapshotLimitations,
  snapshotRefs,
  snapshotValidity,
  type EvaluationDisclosure,
  type EvaluationFailure,
  type EvaluationLimitation,
  type EvaluationRecordRef,
  type EvaluationSchemaRef,
  type EvaluationValidity,
} from "../contract/EvaluationPrimitives.js";
import type { EvaluationDimension } from "../definition/EvaluationDefinition.js";
import {
  appendEvaluationRecord,
  type EvaluationImmutableRecordStore,
} from "../persistence/EvaluationPersistence.js";
import type { EvaluationClock } from "../trial/EvaluationTrial.js";

export type EvaluationGraderKind =
  | "deterministic"
  | "reference"
  | "human_input"
  | "hosted_model";

export type EvaluationCriterionValueSchema =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "scalar";
      readonly minimum: number;
      readonly maximum: number;
      readonly unit: string;
    }
  | {
      readonly kind: "categorical";
      readonly categories: readonly string[];
    };

export interface EvaluationCriterion {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly description: string;
  readonly dimension: EvaluationDimension;
  readonly valueSchema: EvaluationCriterionValueSchema;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationGraderSlotRequirement {
  readonly slotId: string;
  readonly schemaRef: EvaluationSchemaRef;
}

export interface EvaluationGraderDefinition {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly kind: EvaluationGraderKind;
  readonly criterionRef: EvaluationRecordRef;
  readonly rubricRef: EvaluationRecordRef;
  readonly requiredSlots: readonly EvaluationGraderSlotRequirement[];
  readonly outputSchemaRef: EvaluationSchemaRef;
  readonly calibrationRefs: readonly EvaluationRecordRef[];
  readonly validity: EvaluationValidity;
  readonly disclosure: EvaluationDisclosure;
  readonly dataResidency: string;
  readonly requireActorAttribution: boolean;
  readonly requireModelAttribution: boolean;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export type EvaluationGradeValue =
  | { readonly kind: "boolean"; readonly value: boolean }
  | {
      readonly kind: "scalar";
      readonly value: number;
      readonly minimum: number;
      readonly maximum: number;
      readonly unit: string;
    }
  | {
      readonly kind: "categorical";
      readonly value: string;
      readonly categories: readonly string[];
    };

export type EvaluationGradeUncertainty =
  | {
      readonly status: "available";
      readonly method: string;
      readonly lower: number;
      readonly upper: number;
      readonly confidence: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };

export interface EvaluationGradeAttribution {
  readonly method: string;
  readonly actorRef: EvaluationRecordRef | null;
  readonly modelRef: EvaluationRecordRef | null;
  readonly metadata: EvaluationDataObject;
}

export interface EvaluationGradeCandidate {
  readonly value: EvaluationGradeValue;
  readonly criterionOutcome: "satisfied" | "not_satisfied" | "indeterminate";
  readonly evidenceRefs: readonly EvaluationRecordRef[];
  readonly captureSlotIds: readonly string[];
  readonly rationale: string;
  readonly uncertainty: EvaluationGradeUncertainty;
  readonly attribution: EvaluationGradeAttribution;
  readonly disagreementGroup: string | null;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationGrade {
  readonly ref: EvaluationRecordRef;
  readonly captureRef: EvaluationRecordRef;
  readonly criterionRef: EvaluationRecordRef;
  readonly graderRef: EvaluationRecordRef;
  readonly value: EvaluationGradeValue;
  readonly criterionOutcome: EvaluationGradeCandidate["criterionOutcome"];
  readonly evidenceRefs: readonly EvaluationRecordRef[];
  readonly captureSlotIds: readonly string[];
  readonly rationale: string;
  readonly uncertainty: EvaluationGradeUncertainty;
  readonly attribution: EvaluationGradeAttribution;
  readonly disagreementGroup: string | null;
  readonly gradedAt: string;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationGradeRequest {
  readonly gradeRef: EvaluationRecordRef;
  readonly capture: EvaluationCapture;
  readonly criterion: EvaluationCriterion;
  readonly grader: EvaluationGraderDefinition;
  readonly requestedAt: string;
  readonly metadata: EvaluationDataObject;
}

export type EvaluationGradingOutcomeStatus =
  | "graded"
  | "invalid"
  | "unavailable"
  | "failed"
  | "cancelled"
  | "timed_out";

export type EvaluationGraderResponse =
  | { readonly status: "graded"; readonly candidate: EvaluationGradeCandidate }
  | {
      readonly status: "invalid" | "unavailable" | "failed" | "cancelled" | "timed_out";
      readonly failure: EvaluationFailure;
    };

export interface EvaluationGradingResult {
  readonly status: EvaluationGradingOutcomeStatus;
  readonly grade: EvaluationGrade | null;
  readonly failure: EvaluationFailure | null;
}

interface EvaluationTypedGraderPort<TKind extends EvaluationGraderKind> {
  readonly kind: TKind;
  grade(
    request: EvaluationGradeRequest,
    control: EvaluationOperationControl,
  ): Promise<EvaluationGraderResponse>;
}

export type EvaluationDeterministicGraderPort =
  EvaluationTypedGraderPort<"deterministic">;
export type EvaluationReferenceGraderPort = EvaluationTypedGraderPort<"reference">;
export type EvaluationHumanInputGraderPort = EvaluationTypedGraderPort<"human_input">;
export type EvaluationHostedModelGraderPort = EvaluationTypedGraderPort<"hosted_model">;

export type EvaluationGraderPort =
  | EvaluationDeterministicGraderPort
  | EvaluationReferenceGraderPort
  | EvaluationHumanInputGraderPort
  | EvaluationHostedModelGraderPort;

export interface EvaluationGradingExecutionDependencies {
  readonly gradeStore: EvaluationImmutableRecordStore<EvaluationGrade>;
  readonly clock: EvaluationClock;
  readonly deadline: EvaluationDeadlinePort;
}

export class DeterministicEvaluationGrader
  implements EvaluationDeterministicGraderPort {
  readonly kind = "deterministic" as const;
  readonly #evaluate: (
    request: EvaluationGradeRequest,
    control: EvaluationOperationControl,
  ) => EvaluationGradeCandidate | Promise<EvaluationGradeCandidate>;

  constructor(input: {
    readonly evaluate: (
      request: EvaluationGradeRequest,
      control: EvaluationOperationControl,
    ) => EvaluationGradeCandidate | Promise<EvaluationGradeCandidate>;
  }) {
    this.#evaluate = input.evaluate;
  }

  async grade(
    request: EvaluationGradeRequest,
    control: EvaluationOperationControl,
  ): Promise<EvaluationGraderResponse> {
    return Object.freeze({
      status: "graded",
      candidate: await this.#evaluate(request, control),
    });
  }
}

export class ReferenceEvaluationGrader implements EvaluationReferenceGraderPort {
  readonly kind = "reference" as const;
  readonly #evaluate: (
    request: EvaluationGradeRequest,
    control: EvaluationOperationControl,
  ) => EvaluationGradeCandidate | Promise<EvaluationGradeCandidate>;

  constructor(input: {
    readonly evaluate: (
      request: EvaluationGradeRequest,
      control: EvaluationOperationControl,
    ) => EvaluationGradeCandidate | Promise<EvaluationGradeCandidate>;
  }) {
    this.#evaluate = input.evaluate;
  }

  async grade(
    request: EvaluationGradeRequest,
    control: EvaluationOperationControl,
  ): Promise<EvaluationGraderResponse> {
    return Object.freeze({
      status: "graded",
      candidate: await this.#evaluate(request, control),
    });
  }
}

export class EvaluationGradingExecution {
  readonly #dependencies: EvaluationGradingExecutionDependencies;

  constructor(dependencies: EvaluationGradingExecutionDependencies) {
    this.#dependencies = dependencies;
  }

  async grade(
    input: EvaluationGradeRequest,
    port: EvaluationGraderPort,
    control: EvaluationOperationControl,
  ): Promise<EvaluationGradingResult> {
    let request: EvaluationGradeRequest;
    try {
      request = snapshotGradeRequest(input);
      assertGradingPreconditions(request, port);
    } catch {
      return failedGradingResult("invalid", graderFailure(
        "evaluation_grader_invalid",
        "Evaluation Grader request or Capture preconditions are invalid.",
      ));
    }

    const result = await runControlledOperation(
      (signal) => port.grade(request, {
        signal,
        deadlineAt: control.deadlineAt,
      }),
      control,
      this.#dependencies.deadline,
    );
    if (result.status === "cancelled") {
      return failedGradingResult("cancelled", createEvaluationFailure({
        code: "evaluation_cancelled",
        stage: "cancellation",
        message: "Evaluation grading was cancelled.",
        retryable: false,
        causeOwner: "evaluation.grading",
        details: {},
      }));
    }
    if (result.status === "timed_out") {
      return failedGradingResult("timed_out", createEvaluationFailure({
        code: "evaluation_timed_out",
        stage: "timeout",
        message: "Evaluation grading exceeded its deadline.",
        retryable: false,
        causeOwner: "evaluation.grading",
        details: {},
      }));
    }
    if (result.status === "failed") {
      return failedGradingResult("failed", graderFailure(
        "evaluation_grader_failed",
        "Evaluation Grader port threw an exception.",
      ));
    }
    if (result.value.status !== "graded") {
      try {
        assertGraderOutcomeFailure(result.value.status, result.value.failure);
      } catch {
        return failedGradingResult("invalid", graderFailure(
          "evaluation_grader_invalid",
          "Evaluation Grader outcome and Failure do not agree.",
        ));
      }
      return Object.freeze({
        status: result.value.status,
        grade: null,
        failure: createEvaluationFailure(result.value.failure),
      });
    }

    let grade: EvaluationGrade;
    try {
      grade = createEvaluationGrade({
        ref: request.gradeRef,
        captureRef: request.capture.ref,
        criterionRef: request.criterion.ref,
        graderRef: request.grader.ref,
        ...result.value.candidate,
        gradedAt: this.#now(),
      });
      assertGradeMatchesCriterion(grade, request.criterion, request.grader, request.capture);
    } catch {
      return failedGradingResult("invalid", graderFailure(
        "evaluation_grader_invalid",
        "Evaluation Grader output does not satisfy its declared Contract.",
      ));
    }
    await appendEvaluationRecord(this.#dependencies.gradeStore, grade);
    return Object.freeze({ status: "graded", grade, failure: null });
  }

  #now(): string {
    const value = this.#dependencies.clock.now();
    assertIsoTime(value, "EvaluationClock.now");
    return value;
  }
}

export function createEvaluationCriterion(
  input: EvaluationCriterion,
): EvaluationCriterion {
  assertText(input?.name, "EvaluationCriterion.name", 512);
  assertText(input.description, "EvaluationCriterion.description", 4_096);
  assertDimension(input.dimension);
  assertIsoTime(input.createdAt, "EvaluationCriterion.createdAt");
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationCriterion.ref"),
    name: input.name,
    description: input.description,
    dimension: input.dimension,
    valueSchema: snapshotCriterionValueSchema(input.valueSchema),
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationCriterion.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationCriterion.limitations"),
  });
}

export function createEvaluationGraderDefinition(
  input: EvaluationGraderDefinition,
): EvaluationGraderDefinition {
  assertText(input?.name, "EvaluationGraderDefinition.name", 512);
  assertGraderKind(input.kind);
  assertArray(input.requiredSlots, "EvaluationGraderDefinition.requiredSlots");
  if (input.requiredSlots.length === 0) {
    throw new TypeError("EvaluationGraderDefinition.requiredSlots must not be empty.");
  }
  const slotIds = new Set<string>();
  const requiredSlots = input.requiredSlots.map((slot, index) => {
    const path = `EvaluationGraderDefinition.requiredSlots[${index}]`;
    assertToken(slot?.slotId, `${path}.slotId`);
    if (slotIds.has(slot.slotId)) throw new TypeError(`Grader slot '${slot.slotId}' is duplicated.`);
    slotIds.add(slot.slotId);
    return Object.freeze({
      slotId: slot.slotId,
      schemaRef: createEvaluationSchemaRef(slot.schemaRef, `${path}.schemaRef`),
    });
  });
  if (input.disclosure !== "public" && input.disclosure !== "internal" && input.disclosure !== "restricted") {
    throw new TypeError("EvaluationGraderDefinition.disclosure is unsupported.");
  }
  assertToken(input.dataResidency, "EvaluationGraderDefinition.dataResidency");
  if (
    typeof input.requireActorAttribution !== "boolean" ||
    typeof input.requireModelAttribution !== "boolean"
  ) throw new TypeError("Evaluation Grader attribution requirements must be boolean.");
  assertIsoTime(input.createdAt, "EvaluationGraderDefinition.createdAt");
  const calibrationRefs = snapshotRefs(
    input.calibrationRefs,
    "EvaluationGraderDefinition.calibrationRefs",
  );
  if (calibrationRefs.length === 0) {
    throw new TypeError("EvaluationGraderDefinition.calibrationRefs must not be empty.");
  }
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationGraderDefinition.ref"),
    name: input.name,
    kind: input.kind,
    criterionRef: createEvaluationRecordRef(
      input.criterionRef,
      "EvaluationGraderDefinition.criterionRef",
    ),
    rubricRef: createEvaluationRecordRef(input.rubricRef, "EvaluationGraderDefinition.rubricRef"),
    requiredSlots: Object.freeze(requiredSlots.sort((left, right) =>
      compareText(left.slotId, right.slotId))),
    outputSchemaRef: createEvaluationSchemaRef(
      input.outputSchemaRef,
      "EvaluationGraderDefinition.outputSchemaRef",
    ),
    calibrationRefs: Object.freeze([...calibrationRefs].sort((left, right) =>
      compareText(evaluationRefKey(left), evaluationRefKey(right)))),
    validity: snapshotValidity(input.validity, "EvaluationGraderDefinition.validity"),
    disclosure: input.disclosure,
    dataResidency: input.dataResidency,
    requireActorAttribution: input.requireActorAttribution,
    requireModelAttribution: input.requireModelAttribution,
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationGraderDefinition.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationGraderDefinition.limitations"),
  });
}

export function createEvaluationGrade(input: EvaluationGrade): EvaluationGrade {
  assertIsoTime(input?.gradedAt, "EvaluationGrade.gradedAt");
  const value = snapshotGradeValue(input.value);
  if (!(["satisfied", "not_satisfied", "indeterminate"] as const).includes(input.criterionOutcome)) {
    throw new TypeError("EvaluationGrade.criterionOutcome is unsupported.");
  }
  assertText(input.rationale, "EvaluationGrade.rationale", 4_096);
  const captureSlotIds = uniqueTokens(input.captureSlotIds, "EvaluationGrade.captureSlotIds");
  const uncertainty = snapshotUncertainty(input.uncertainty);
  const attribution = snapshotAttribution(input.attribution);
  if (input.disagreementGroup !== null) {
    assertToken(input.disagreementGroup, "EvaluationGrade.disagreementGroup");
  }
  return Object.freeze({
    ref: createEvaluationRecordRef(input.ref, "EvaluationGrade.ref"),
    captureRef: createEvaluationRecordRef(input.captureRef, "EvaluationGrade.captureRef"),
    criterionRef: createEvaluationRecordRef(input.criterionRef, "EvaluationGrade.criterionRef"),
    graderRef: createEvaluationRecordRef(input.graderRef, "EvaluationGrade.graderRef"),
    value,
    criterionOutcome: input.criterionOutcome,
    evidenceRefs: snapshotRefs(input.evidenceRefs, "EvaluationGrade.evidenceRefs"),
    captureSlotIds,
    rationale: input.rationale,
    uncertainty,
    attribution,
    disagreementGroup: input.disagreementGroup,
    gradedAt: input.gradedAt,
    limitations: snapshotLimitations(input.limitations, "EvaluationGrade.limitations"),
  });
}

function snapshotGradeRequest(input: EvaluationGradeRequest): EvaluationGradeRequest {
  const criterion = createEvaluationCriterion(input?.criterion);
  const grader = createEvaluationGraderDefinition(input.grader);
  if (!isEvaluationRefEqual(criterion.ref, grader.criterionRef)) {
    throw new TypeError("Evaluation Grader and Criterion revisions do not agree.");
  }
  assertIsoTime(input.requestedAt, "EvaluationGradeRequest.requestedAt");
  if (
    (grader.validity.validFrom !== null && input.requestedAt < grader.validity.validFrom) ||
    (grader.validity.validUntil !== null && input.requestedAt > grader.validity.validUntil)
  ) {
    throw new TypeError("Evaluation Grader is not valid at the requested time.");
  }
  return Object.freeze({
    gradeRef: createEvaluationRecordRef(input.gradeRef, "EvaluationGradeRequest.gradeRef"),
    capture: input.capture,
    criterion,
    grader,
    requestedAt: input.requestedAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationGradeRequest.metadata"),
  });
}

function assertGradingPreconditions(
  request: EvaluationGradeRequest,
  port: EvaluationGraderPort,
): void {
  if (port.kind !== request.grader.kind) throw new TypeError("Grader port kind does not match definition.");
  for (const requirement of request.grader.requiredSlots) {
    const slot = request.capture.slots.find((candidate) => candidate.slotId === requirement.slotId);
    if (
      slot?.status !== "captured" ||
      slot.schemaRef.schemaId !== requirement.schemaRef.schemaId ||
      slot.schemaRef.revision !== requirement.schemaRef.revision
    ) {
      throw new TypeError(`Required Capture slot '${requirement.slotId}' is unavailable or invalid.`);
    }
    if (!slot.consumers.some((consumer) =>
      consumer.kind === "grader" && isEvaluationRefEqual(consumer.ref, request.grader.ref))) {
      throw new TypeError(`Grader is not admitted to consume Capture slot '${requirement.slotId}'.`);
    }
  }
}

function assertGradeMatchesCriterion(
  grade: EvaluationGrade,
  criterion: EvaluationCriterion,
  grader: EvaluationGraderDefinition,
  capture: EvaluationCapture,
): void {
  if (grade.value.kind !== criterion.valueSchema.kind) {
    throw new TypeError("Grade value kind does not match Criterion.");
  }
  if (grade.value.kind === "boolean") {
    const expectedOutcome = grade.value.value ? "satisfied" : "not_satisfied";
    if (grade.criterionOutcome !== expectedOutcome) {
      throw new TypeError("Boolean Grade value and criterion outcome do not agree.");
    }
  }
  if (grade.value.kind === "scalar" && criterion.valueSchema.kind === "scalar") {
    if (
      grade.value.minimum !== criterion.valueSchema.minimum ||
      grade.value.maximum !== criterion.valueSchema.maximum ||
      grade.value.unit !== criterion.valueSchema.unit
    ) throw new TypeError("Grade scalar scale does not match Criterion.");
  }
  if (grade.value.kind === "categorical" && criterion.valueSchema.kind === "categorical") {
    if (JSON.stringify(grade.value.categories) !== JSON.stringify(criterion.valueSchema.categories)) {
      throw new TypeError("Grade categories do not match Criterion.");
    }
  }
  if (grader.requireActorAttribution && grade.attribution.actorRef === null) {
    throw new TypeError("Grade is missing required actor attribution.");
  }
  if (grader.requireModelAttribution && grade.attribution.modelRef === null) {
    throw new TypeError("Grade is missing required model attribution.");
  }
  for (const slotId of grade.captureSlotIds) {
    if (!capture.slots.some((slot) => slot.slotId === slotId && slot.status === "captured")) {
      throw new TypeError(`Grade references unavailable Capture slot '${slotId}'.`);
    }
  }
}

function snapshotCriterionValueSchema(
  input: EvaluationCriterionValueSchema,
): EvaluationCriterionValueSchema {
  switch (input?.kind) {
    case "boolean": return Object.freeze({ kind: "boolean" });
    case "scalar":
      assertFiniteRange(input.minimum, input.maximum, "EvaluationCriterion.valueSchema");
      assertToken(input.unit, "EvaluationCriterion.valueSchema.unit");
      return Object.freeze({ ...input });
    case "categorical":
      return Object.freeze({
        kind: "categorical",
        categories: uniqueTokens(input.categories, "EvaluationCriterion.valueSchema.categories"),
      });
    default:
      throw new TypeError("EvaluationCriterion.valueSchema is unsupported.");
  }
}

function snapshotGradeValue(input: EvaluationGradeValue): EvaluationGradeValue {
  switch (input?.kind) {
    case "boolean":
      if (typeof input.value !== "boolean") throw new TypeError("Boolean Grade value is invalid.");
      return Object.freeze({ kind: "boolean", value: input.value });
    case "scalar":
      assertFiniteRange(input.minimum, input.maximum, "EvaluationGrade.value");
      if (!Number.isFinite(input.value) || input.value < input.minimum || input.value > input.maximum) {
        throw new TypeError("Scalar Grade value is outside its declared scale.");
      }
      assertToken(input.unit, "EvaluationGrade.value.unit");
      return Object.freeze({ ...input });
    case "categorical": {
      const categories = uniqueTokens(input.categories, "EvaluationGrade.value.categories");
      assertToken(input.value, "EvaluationGrade.value.value");
      if (!categories.includes(input.value)) throw new TypeError("Categorical Grade value is not admitted.");
      return Object.freeze({ kind: "categorical", value: input.value, categories });
    }
    default:
      throw new TypeError("EvaluationGrade.value is unsupported.");
  }
}

function snapshotUncertainty(input: EvaluationGradeUncertainty): EvaluationGradeUncertainty {
  if (input?.status === "unavailable") {
    assertText(input.reason, "EvaluationGrade.uncertainty.reason", 1_024);
    return Object.freeze({ status: "unavailable", reason: input.reason });
  }
  if (input?.status !== "available") throw new TypeError("EvaluationGrade.uncertainty is unsupported.");
  assertToken(input.method, "EvaluationGrade.uncertainty.method");
  if (
    !Number.isFinite(input.lower) ||
    !Number.isFinite(input.upper) ||
    input.lower > input.upper ||
    !Number.isFinite(input.confidence) ||
    input.confidence <= 0 ||
    input.confidence >= 1
  ) throw new TypeError("EvaluationGrade uncertainty interval is invalid.");
  return Object.freeze({ ...input });
}

function snapshotAttribution(input: EvaluationGradeAttribution): EvaluationGradeAttribution {
  assertToken(input?.method, "EvaluationGrade.attribution.method");
  return Object.freeze({
    method: input.method,
    actorRef: input.actorRef === null
      ? null
      : createEvaluationRecordRef(input.actorRef, "EvaluationGrade.attribution.actorRef"),
    modelRef: input.modelRef === null
      ? null
      : createEvaluationRecordRef(input.modelRef, "EvaluationGrade.attribution.modelRef"),
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationGrade.attribution.metadata"),
  });
}

function failedGradingResult(
  status: Exclude<EvaluationGradingOutcomeStatus, "graded">,
  failure: EvaluationFailure,
): EvaluationGradingResult {
  return Object.freeze({ status, grade: null, failure });
}

function graderFailure(
  code: "evaluation_grader_invalid" | "evaluation_grader_unavailable" | "evaluation_grader_failed",
  message: string,
): EvaluationFailure {
  return createEvaluationFailure({
    code,
    stage: "grading",
    message,
    retryable: code === "evaluation_grader_unavailable",
    causeOwner: "evaluation.grading",
    details: {},
  });
}

function assertGraderOutcomeFailure(
  status: Exclude<EvaluationGradingOutcomeStatus, "graded">,
  failure: EvaluationFailure,
): void {
  const expected: Readonly<Record<Exclude<EvaluationGradingOutcomeStatus, "graded">, EvaluationFailure["code"]>> = {
    invalid: "evaluation_grader_invalid",
    unavailable: "evaluation_grader_unavailable",
    failed: "evaluation_grader_failed",
    cancelled: "evaluation_cancelled",
    timed_out: "evaluation_timed_out",
  };
  if (failure.code !== expected[status]) {
    throw new TypeError("Evaluation Grader outcome and Failure do not agree.");
  }
}

function uniqueTokens(input: readonly string[], path: string): readonly string[] {
  assertArray(input, path);
  const values = input.map((item, index) => {
    assertToken(item, `${path}[${index}]`);
    return item;
  });
  if (new Set(values).size !== values.length || values.length === 0) {
    throw new TypeError(`${path} must be non-empty and unique.`);
  }
  return Object.freeze([...values].sort(compareText));
}

function assertFiniteRange(minimum: number, maximum: number, path: string): void {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum >= maximum) {
    throw new TypeError(`${path} range is invalid.`);
  }
}

function assertGraderKind(value: EvaluationGraderKind): void {
  if (!(["deterministic", "reference", "human_input", "hosted_model"] as const).includes(value)) {
    throw new TypeError("EvaluationGraderDefinition.kind is unsupported.");
  }
}

function assertDimension(value: EvaluationDimension): void {
  if (!([
    "outcome_quality",
    "safety",
    "reliability",
    "collaboration",
    "trajectory",
    "final_communication",
    "diagnostic_quality",
    "efficiency",
  ] as const).includes(value)) throw new TypeError("EvaluationCriterion.dimension is unsupported.");
}
