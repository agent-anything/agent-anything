import {
  assertSafeProjectionData,
  compareText,
  contractError,
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
  createEvaluationRecordRef,
  createEvaluationSchemaRef,
  evaluationRefKey,
  isEvaluationRefEqual,
  sensitivityRank,
  snapshotLimitations,
  snapshotProvenance,
  snapshotRefs,
  snapshotValidity,
  type EvaluationDisclosure,
  type EvaluationLimitation,
  type EvaluationProvenance,
  type EvaluationRecordRef,
  type EvaluationSchemaRef,
  type EvaluationSensitivity,
  type EvaluationValidity,
} from "../contract/EvaluationPrimitives.js";

export type EvaluationDimension =
  | "outcome_quality"
  | "safety"
  | "reliability"
  | "collaboration"
  | "trajectory"
  | "final_communication"
  | "diagnostic_quality"
  | "efficiency";

export interface EvaluationBehaviorInputRequirement {
  readonly key: string;
  readonly owner: string;
  readonly required: boolean;
  readonly schemaRef: EvaluationSchemaRef;
  readonly maximumSensitivity: EvaluationSensitivity;
  readonly description: string;
}

export interface EvaluationObjective {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly decision: string;
  readonly dimensions: readonly EvaluationDimension[];
  readonly criterionRefs: readonly EvaluationRecordRef[];
  readonly qualityGateRefs: readonly EvaluationRecordRef[];
  readonly safetyGateRefs: readonly EvaluationRecordRef[];
  readonly behaviorInputRequirements: readonly EvaluationBehaviorInputRequirement[];
  readonly suiteConstraints: EvaluationDataObject;
  readonly comparisonBasis: EvaluationDataObject;
  readonly acceptableExclusionCodes: readonly string[];
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export type EvaluationBehaviorInputStatus =
  | "captured"
  | "omitted"
  | "unavailable"
  | "invalid"
  | "redacted";

export type EvaluationBehaviorInputRepresentation =
  | {
      readonly kind: "value";
      readonly value: EvaluationDataValue;
    }
  | {
      readonly kind: "opaque_ref";
      readonly ref: EvaluationRecordRef;
    }
  | {
      readonly kind: "fingerprint";
      readonly fingerprint: string;
    };

export interface EvaluationBehaviorInputEntry {
  readonly key: string;
  readonly owner: string;
  readonly required: boolean;
  readonly sourceRevision: string;
  readonly schemaRef: EvaluationSchemaRef;
  readonly status: EvaluationBehaviorInputStatus;
  readonly representation: EvaluationBehaviorInputRepresentation | null;
  readonly sensitivity: EvaluationSensitivity;
  readonly disclosure: EvaluationDisclosure;
  readonly limitation: EvaluationLimitation | null;
}

export interface EvaluationTargetSnapshot {
  readonly ref: EvaluationRecordRef;
  readonly objectiveRef: EvaluationRecordRef;
  readonly targetRef: EvaluationRecordRef;
  readonly manifest: readonly EvaluationBehaviorInputEntry[];
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export type EvaluationCorpusPurpose =
  | "tuning"
  | "regression"
  | "held_out"
  | "benchmark";

export type EvaluationCorpusVisibility = "private" | "internal" | "public";

export interface EvaluationCorpusPartition {
  readonly purpose: EvaluationCorpusPurpose;
  readonly visibility: EvaluationCorpusVisibility;
}

export interface EvaluationBudget {
  readonly maximumDurationMs: number;
  readonly maximumCost: number | null;
  readonly maximumTokens: number | null;
  readonly maximumOperations: number | null;
}

export interface EvaluationCase {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly targetInput: EvaluationDataValue;
  readonly fixtureRefs: readonly EvaluationRecordRef[];
  readonly expectedClaimRefs: readonly EvaluationRecordRef[];
  readonly criterionRefs: readonly EvaluationRecordRef[];
  readonly graderRefs: readonly EvaluationRecordRef[];
  readonly budget: EvaluationBudget;
  readonly distributionKey: string;
  readonly pairingKey: string | null;
  readonly partition: EvaluationCorpusPartition;
  readonly provenance: EvaluationProvenance;
  readonly validity: EvaluationValidity;
  readonly supersedes: EvaluationRecordRef | null;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export interface EvaluationSuite {
  readonly ref: EvaluationRecordRef;
  readonly name: string;
  readonly caseRefs: readonly EvaluationRecordRef[];
  readonly distribution: EvaluationDataObject;
  readonly selectionRules: EvaluationDataObject;
  readonly validity: EvaluationValidity;
  readonly provenance: EvaluationProvenance;
  readonly supersedes: EvaluationRecordRef | null;
  readonly createdAt: string;
  readonly metadata: EvaluationDataObject;
  readonly limitations: readonly EvaluationLimitation[];
}

export function createEvaluationObjective(
  input: EvaluationObjective,
): EvaluationObjective {
  const ref = createEvaluationRecordRef(input?.ref, "EvaluationObjective.ref");
  assertText(input.name, "EvaluationObjective.name", 512);
  assertText(input.decision, "EvaluationObjective.decision", 4_096);
  const dimensions = snapshotDimensions(input.dimensions);
  const criterionRefs = snapshotSortedRefs(
    input.criterionRefs,
    "EvaluationObjective.criterionRefs",
  );
  if (criterionRefs.length === 0) {
    throw definitionError("EvaluationObjective must declare at least one criterion.", "criterionRefs");
  }
  const requirements = snapshotBehaviorInputRequirements(
    input.behaviorInputRequirements,
  );
  if (requirements.length === 0) {
    throw definitionError(
      "EvaluationObjective must declare behavior input requirements.",
      "behaviorInputRequirements",
    );
  }
  assertIsoTime(input.createdAt, "EvaluationObjective.createdAt");

  return Object.freeze({
    ref,
    name: input.name,
    decision: input.decision,
    dimensions,
    criterionRefs,
    qualityGateRefs: snapshotSortedRefs(
      input.qualityGateRefs,
      "EvaluationObjective.qualityGateRefs",
    ),
    safetyGateRefs: snapshotSortedRefs(
      input.safetyGateRefs,
      "EvaluationObjective.safetyGateRefs",
    ),
    behaviorInputRequirements: requirements,
    suiteConstraints: snapshotEvaluationDataObject(
      input.suiteConstraints,
      "EvaluationObjective.suiteConstraints",
    ),
    comparisonBasis: snapshotEvaluationDataObject(
      input.comparisonBasis,
      "EvaluationObjective.comparisonBasis",
    ),
    acceptableExclusionCodes: snapshotTokens(
      input.acceptableExclusionCodes,
      "EvaluationObjective.acceptableExclusionCodes",
    ),
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationObjective.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationObjective.limitations"),
  });
}

export function createEvaluationTargetSnapshot(
  input: EvaluationTargetSnapshot,
  objective: EvaluationObjective,
): EvaluationTargetSnapshot {
  const ref = createEvaluationRecordRef(input?.ref, "EvaluationTargetSnapshot.ref");
  const objectiveRef = createEvaluationRecordRef(
    input.objectiveRef,
    "EvaluationTargetSnapshot.objectiveRef",
  );
  if (!isEvaluationRefEqual(objectiveRef, objective.ref)) {
    throw targetSnapshotError("Target Snapshot uses a different Objective revision.", "objectiveRef");
  }
  const targetRef = createEvaluationRecordRef(
    input.targetRef,
    "EvaluationTargetSnapshot.targetRef",
  );
  assertArray(input.manifest, "EvaluationTargetSnapshot.manifest");
  const requirementByKey = new Map(
    objective.behaviorInputRequirements.map((requirement) => [requirement.key, requirement]),
  );
  const seen = new Set<string>();
  const manifest = input.manifest.map((entry, index) => {
    const path = `EvaluationTargetSnapshot.manifest[${index}]`;
    assertToken(entry?.key, `${path}.key`);
    if (seen.has(entry.key)) {
      throw targetSnapshotError(`Manifest key '${entry.key}' is duplicated.`, `${path}.key`);
    }
    seen.add(entry.key);
    const requirement = requirementByKey.get(entry.key);
    if (!requirement) {
      throw targetSnapshotError(`Manifest key '${entry.key}' is not admitted.`, `${path}.key`);
    }
    return snapshotBehaviorInputEntry(entry, requirement, path);
  });
  for (const requirement of objective.behaviorInputRequirements) {
    if (!seen.has(requirement.key)) {
      throw targetSnapshotError(
        `Manifest is missing '${requirement.key}'.`,
        "manifest",
      );
    }
  }
  assertIsoTime(input.createdAt, "EvaluationTargetSnapshot.createdAt");
  return Object.freeze({
    ref,
    objectiveRef,
    targetRef,
    manifest: Object.freeze(manifest.sort((left, right) => compareText(left.key, right.key))),
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationTargetSnapshot.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationTargetSnapshot.limitations"),
  });
}

export function createEvaluationCase(input: EvaluationCase): EvaluationCase {
  const ref = createEvaluationRecordRef(input?.ref, "EvaluationCase.ref");
  assertText(input.name, "EvaluationCase.name", 512);
  assertToken(input.distributionKey, "EvaluationCase.distributionKey");
  if (input.pairingKey !== null) assertToken(input.pairingKey, "EvaluationCase.pairingKey");
  assertIsoTime(input.createdAt, "EvaluationCase.createdAt");
  const supersedes = snapshotSupersedes(input.supersedes, ref, "EvaluationCase.supersedes");
  return Object.freeze({
    ref,
    name: input.name,
    targetInput: snapshotEvaluationData(input.targetInput, "EvaluationCase.targetInput"),
    fixtureRefs: snapshotSortedRefs(input.fixtureRefs, "EvaluationCase.fixtureRefs"),
    expectedClaimRefs: snapshotSortedRefs(
      input.expectedClaimRefs,
      "EvaluationCase.expectedClaimRefs",
    ),
    criterionRefs: snapshotRequiredRefs(input.criterionRefs, "EvaluationCase.criterionRefs"),
    graderRefs: snapshotRequiredRefs(input.graderRefs, "EvaluationCase.graderRefs"),
    budget: snapshotBudget(input.budget, "EvaluationCase.budget"),
    distributionKey: input.distributionKey,
    pairingKey: input.pairingKey,
    partition: snapshotPartition(input.partition),
    provenance: snapshotProvenance(input.provenance, "EvaluationCase.provenance"),
    validity: snapshotValidity(input.validity, "EvaluationCase.validity"),
    supersedes,
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationCase.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationCase.limitations"),
  });
}

export function createEvaluationSuite(
  input: EvaluationSuite,
  admittedCases: readonly EvaluationCase[],
): EvaluationSuite {
  const ref = createEvaluationRecordRef(input?.ref, "EvaluationSuite.ref");
  assertText(input.name, "EvaluationSuite.name", 512);
  const caseRefs = snapshotRequiredRefs(input.caseRefs, "EvaluationSuite.caseRefs");
  const admitted = new Set(admittedCases.map((item) => evaluationRefKey(item.ref)));
  for (const caseRef of caseRefs) {
    if (!admitted.has(evaluationRefKey(caseRef))) {
      throw suiteError(
        `Suite Case ref '${evaluationRefKey(caseRef)}' is not admitted.`,
        "caseRefs",
      );
    }
  }
  assertIsoTime(input.createdAt, "EvaluationSuite.createdAt");
  const supersedes = snapshotSupersedes(input.supersedes, ref, "EvaluationSuite.supersedes");
  return Object.freeze({
    ref,
    name: input.name,
    caseRefs: Object.freeze([...caseRefs].sort(compareRefs)),
    distribution: snapshotEvaluationDataObject(input.distribution, "EvaluationSuite.distribution"),
    selectionRules: snapshotEvaluationDataObject(
      input.selectionRules,
      "EvaluationSuite.selectionRules",
    ),
    validity: snapshotValidity(input.validity, "EvaluationSuite.validity"),
    provenance: snapshotProvenance(input.provenance, "EvaluationSuite.provenance"),
    supersedes,
    createdAt: input.createdAt,
    metadata: snapshotEvaluationDataObject(input.metadata, "EvaluationSuite.metadata"),
    limitations: snapshotLimitations(input.limitations, "EvaluationSuite.limitations"),
  });
}

function snapshotBehaviorInputRequirements(
  input: readonly EvaluationBehaviorInputRequirement[],
): readonly EvaluationBehaviorInputRequirement[] {
  assertArray(input, "EvaluationObjective.behaviorInputRequirements");
  const seen = new Set<string>();
  const result = input.map((requirement, index) => {
    const path = `EvaluationObjective.behaviorInputRequirements[${index}]`;
    assertToken(requirement?.key, `${path}.key`);
    if (seen.has(requirement.key)) {
      throw definitionError(`Behavior input '${requirement.key}' is duplicated.`, path);
    }
    seen.add(requirement.key);
    assertToken(requirement.owner, `${path}.owner`);
    if (typeof requirement.required !== "boolean") {
      throw definitionError(`${path}.required must be boolean.`, `${path}.required`);
    }
    assertSensitivity(requirement.maximumSensitivity, `${path}.maximumSensitivity`);
    assertText(requirement.description, `${path}.description`, 1_024);
    return Object.freeze({
      key: requirement.key,
      owner: requirement.owner,
      required: requirement.required,
      schemaRef: createEvaluationSchemaRef(requirement.schemaRef, `${path}.schemaRef`),
      maximumSensitivity: requirement.maximumSensitivity,
      description: requirement.description,
    });
  });
  return Object.freeze(result.sort((left, right) => compareText(left.key, right.key)));
}

function snapshotBehaviorInputEntry(
  entry: EvaluationBehaviorInputEntry,
  requirement: EvaluationBehaviorInputRequirement,
  path: string,
): EvaluationBehaviorInputEntry {
  assertToken(entry.owner, `${path}.owner`);
  if (entry.owner !== requirement.owner || entry.required !== requirement.required) {
    throw targetSnapshotError(
      `Manifest entry '${entry.key}' contradicts its admitted requirement.`,
      path,
    );
  }
  assertToken(entry.sourceRevision, `${path}.sourceRevision`);
  const schemaRef = createEvaluationSchemaRef(entry.schemaRef, `${path}.schemaRef`);
  if (
    schemaRef.schemaId !== requirement.schemaRef.schemaId ||
    schemaRef.revision !== requirement.schemaRef.revision
  ) {
    throw targetSnapshotError(`Manifest entry '${entry.key}' uses another schema.`, path);
  }
  assertBehaviorInputStatus(entry.status, `${path}.status`);
  assertSensitivity(entry.sensitivity, `${path}.sensitivity`);
  if (sensitivityRank(entry.sensitivity) > sensitivityRank(requirement.maximumSensitivity)) {
    throw targetSnapshotError(
      `Manifest entry '${entry.key}' exceeds admitted sensitivity.`,
      `${path}.sensitivity`,
    );
  }
  assertDisclosure(entry.disclosure, `${path}.disclosure`);
  if (disclosureRank(entry.disclosure) < sensitivityRank(entry.sensitivity)) {
    throw targetSnapshotError(
      `Manifest entry '${entry.key}' disclosure is broader than its sensitivity permits.`,
      `${path}.disclosure`,
    );
  }
  const representation = snapshotRepresentation(entry.representation, entry.status, path);
  if (requirement.required && entry.status !== "captured") {
    throw targetSnapshotError(
      `Mandatory manifest entry '${entry.key}' must be captured.`,
      `${path}.status`,
    );
  }
  const limitation = entry.limitation === null
    ? null
    : snapshotLimitations([entry.limitation], `${path}.limitation`)[0];
  if (entry.status !== "captured" && limitation === null) {
    throw targetSnapshotError(
      `Non-captured manifest entry '${entry.key}' requires a limitation.`,
      `${path}.limitation`,
    );
  }
  if (/credential|secret/i.test(entry.key) && representation?.kind === "value") {
    throw targetSnapshotError(
      `Credential manifest entry '${entry.key}' must use a fingerprint or opaque ref.`,
      `${path}.representation`,
    );
  }
  return Object.freeze({
    key: entry.key,
    owner: entry.owner,
    required: entry.required,
    sourceRevision: entry.sourceRevision,
    schemaRef,
    status: entry.status,
    representation,
    sensitivity: entry.sensitivity,
    disclosure: entry.disclosure,
    limitation,
  });
}

function snapshotRepresentation(
  input: EvaluationBehaviorInputRepresentation | null,
  status: EvaluationBehaviorInputStatus,
  path: string,
): EvaluationBehaviorInputRepresentation | null {
  if (status !== "captured") {
    if (input !== null) {
      throw targetSnapshotError("Only captured manifest entries can carry a value.", `${path}.representation`);
    }
    return null;
  }
  if (input === null) {
    throw targetSnapshotError("Captured manifest entry requires a representation.", `${path}.representation`);
  }
  switch (input.kind) {
    case "value":
      {
        const value = snapshotEvaluationData(
          input.value,
          `${path}.representation.value`,
        );
        assertSafeProjectionData(value, `${path}.representation.value`);
        return Object.freeze({ kind: "value", value });
      }
    case "opaque_ref":
      return Object.freeze({
        kind: "opaque_ref",
        ref: createEvaluationRecordRef(input.ref, `${path}.representation.ref`),
      });
    case "fingerprint":
      assertToken(input.fingerprint, `${path}.representation.fingerprint`);
      return Object.freeze({ kind: "fingerprint", fingerprint: input.fingerprint });
  }
}

function snapshotBudget(input: EvaluationBudget, path: string): EvaluationBudget {
  assertPositiveInteger(input?.maximumDurationMs, `${path}.maximumDurationMs`);
  assertOptionalNonNegative(input.maximumCost, `${path}.maximumCost`);
  assertOptionalPositiveInteger(input.maximumTokens, `${path}.maximumTokens`);
  assertOptionalPositiveInteger(input.maximumOperations, `${path}.maximumOperations`);
  return Object.freeze({ ...input });
}

function snapshotPartition(input: EvaluationCorpusPartition): EvaluationCorpusPartition {
  if (!(["tuning", "regression", "held_out", "benchmark"] as const).includes(input?.purpose)) {
    throw definitionError("EvaluationCase partition purpose is unsupported.", "partition.purpose");
  }
  if (!(["private", "internal", "public"] as const).includes(input.visibility)) {
    throw definitionError("EvaluationCase partition visibility is unsupported.", "partition.visibility");
  }
  return Object.freeze({ purpose: input.purpose, visibility: input.visibility });
}

function snapshotDimensions(input: readonly EvaluationDimension[]): readonly EvaluationDimension[] {
  assertArray(input, "EvaluationObjective.dimensions");
  const allowed = new Set<EvaluationDimension>([
    "outcome_quality",
    "safety",
    "reliability",
    "collaboration",
    "trajectory",
    "final_communication",
    "diagnostic_quality",
    "efficiency",
  ]);
  const dimensions = input.map((item, index) => {
    if (!allowed.has(item)) {
      throw definitionError(`Unsupported Evaluation dimension '${String(item)}'.`, `dimensions[${index}]`);
    }
    return item;
  });
  if (dimensions.length === 0 || new Set(dimensions).size !== dimensions.length) {
    throw definitionError("EvaluationObjective dimensions must be non-empty and unique.", "dimensions");
  }
  return Object.freeze([...dimensions].sort(compareText));
}

function snapshotTokens(input: readonly string[], path: string): readonly string[] {
  assertArray(input, path);
  const result = input.map((item, index) => {
    assertToken(item, `${path}[${index}]`);
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw definitionError(`${path} must contain unique tokens.`, path);
  }
  return Object.freeze([...result].sort(compareText));
}

function snapshotRequiredRefs(
  refs: readonly EvaluationRecordRef[],
  path: string,
): readonly EvaluationRecordRef[] {
  const result = snapshotRefs(refs, path);
  if (result.length === 0) throw definitionError(`${path} must not be empty.`, path);
  return Object.freeze([...result].sort(compareRefs));
}

function snapshotSortedRefs(
  refs: readonly EvaluationRecordRef[],
  path: string,
): readonly EvaluationRecordRef[] {
  return Object.freeze([...snapshotRefs(refs, path)].sort(compareRefs));
}

function compareRefs(left: EvaluationRecordRef, right: EvaluationRecordRef): number {
  return compareText(evaluationRefKey(left), evaluationRefKey(right));
}

function assertOptionalNonNegative(value: number | null, path: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw definitionError(`${path} must be a finite non-negative number or null.`, path);
  }
}

function assertOptionalPositiveInteger(value: number | null, path: string): void {
  if (value !== null) assertPositiveInteger(value, path);
}

function assertSensitivity(value: EvaluationSensitivity, path: string): void {
  if (!(["public", "internal", "confidential", "restricted"] as const).includes(value)) {
    throw definitionError(`${path} is unsupported.`, path);
  }
}

function assertDisclosure(value: EvaluationDisclosure, path: string): void {
  if (!(["public", "internal", "restricted"] as const).includes(value)) {
    throw definitionError(`${path} is unsupported.`, path);
  }
}

function disclosureRank(value: EvaluationDisclosure): number {
  return value === "public" ? 0 : value === "internal" ? 1 : 3;
}

function assertBehaviorInputStatus(value: EvaluationBehaviorInputStatus, path: string): void {
  if (!(["captured", "omitted", "unavailable", "invalid", "redacted"] as const).includes(value)) {
    throw targetSnapshotError(`${path} is unsupported.`, path);
  }
}

function snapshotSupersedes(
  input: EvaluationRecordRef | null,
  current: EvaluationRecordRef,
  path: string,
): EvaluationRecordRef | null {
  if (input === null) return null;
  const supersedes = createEvaluationRecordRef(input, path);
  if (isEvaluationRefEqual(supersedes, current)) {
    throw definitionError(`${path} must reference an earlier distinct record.`, path);
  }
  return supersedes;
}

function definitionError(message: string, path: string) {
  return contractError("evaluation_definition_invalid", message, `EvaluationDefinition.${path}`);
}

function targetSnapshotError(message: string, path: string) {
  return contractError(
    "evaluation_definition_invalid",
    message,
    `EvaluationTargetSnapshot.${path}`,
  );
}

function suiteError(message: string, path: string) {
  return contractError("evaluation_definition_invalid", message, `EvaluationSuite.${path}`);
}
