import { createHash } from "node:crypto";
import {
  createEvaluationRecordRef,
  createEvaluationTargetSnapshot,
  snapshotEvaluationData,
  type EvaluationDataObject,
  type EvaluationObjective,
  type EvaluationRecordRef,
  type EvaluationTargetSnapshot,
} from "@agent-anything/evaluation/definition";

import {
  HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL,
} from "./HelarcProductEffectivenessProtocol.js";
import {
  HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS,
  type HelarcProductEffectivenessCaseProfile,
  type HelarcProductEffectivenessSuiteProfile,
} from "./HelarcProductEffectivenessSuite.js";

export type HelarcProductEffectivenessTargetName = "codex" | "helarc";
export type HelarcProductEffectivenessTrialStatus =
  | "completed"
  | "excluded"
  | "unavailable"
  | "invalid"
  | "incomparable";
export type HelarcProductEffectivenessSafetyGate =
  typeof HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates[number];

export interface HelarcProductEffectivenessDiagnostics {
  readonly trajectoryScore: number | null;
  readonly verificationScore: number | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCost: number | null;
  readonly toolCalls: number | null;
  readonly retries: number | null;
  readonly humanInteractionEvents: number | null;
}

export interface HelarcProductEffectivenessTrialProvenance {
  readonly executionSource: "captured" | "imported";
  readonly productVersion: string;
  readonly model: string;
  readonly environment: string;
  readonly graderKind: "deterministic" | "reference" | "human_input" | "hosted_model";
  readonly graderRevision: string;
  readonly capturedAt: string;
  readonly sourceArtifactDigest: string;
  readonly scriptedProviderOutput: false;
  readonly metadata: EvaluationDataObject;
}

export interface HelarcProductEffectivenessTrialEvidence {
  readonly ref: EvaluationRecordRef;
  readonly targetName: HelarcProductEffectivenessTargetName;
  readonly targetSnapshotRef: EvaluationRecordRef;
  readonly suiteRef: EvaluationRecordRef;
  readonly caseRef: EvaluationRecordRef;
  readonly repetitionOrdinal: number;
  readonly pairingKey: string;
  readonly status: HelarcProductEffectivenessTrialStatus;
  readonly outcomeScore: number | null;
  readonly safety: Readonly<Record<HelarcProductEffectivenessSafetyGate, boolean | null>>;
  readonly diagnostics: HelarcProductEffectivenessDiagnostics;
  readonly exclusion: {
    readonly code: string;
    readonly reason: string;
  } | null;
  readonly provenance: HelarcProductEffectivenessTrialProvenance;
  readonly limitations: readonly string[];
}

export interface HelarcProductEffectivenessEvidenceBundle {
  readonly schemaVersion: 1;
  readonly kind: "helarc_product_effectiveness_evidence_bundle";
  readonly targetName: HelarcProductEffectivenessTargetName;
  readonly targetSnapshot: EvaluationTargetSnapshot;
  readonly targetManifestDigest: string;
  readonly suiteRef: EvaluationRecordRef;
  readonly trials: readonly HelarcProductEffectivenessTrialEvidence[];
  readonly createdAt: string;
  readonly limitations: readonly string[];
  readonly bundleDigest: string;
}

export type HelarcProductEffectivenessEvidenceBundleInput = Omit<
  HelarcProductEffectivenessEvidenceBundle,
  "schemaVersion" | "kind" | "targetManifestDigest" | "bundleDigest"
>;

export function sealHelarcProductEffectivenessEvidenceBundle(input: {
  readonly objective: EvaluationObjective;
  readonly suite: HelarcProductEffectivenessSuiteProfile;
  readonly bundle: HelarcProductEffectivenessEvidenceBundleInput;
}): HelarcProductEffectivenessEvidenceBundle {
  const targetSnapshot = createEvaluationTargetSnapshot(
    input.bundle.targetSnapshot,
    input.objective,
  );
  assertTargetName(input.bundle.targetName);
  if (targetSnapshot.metadata.targetName !== input.bundle.targetName) {
    throw new TypeError("Product-effectiveness Target Snapshot targetName does not match its Evidence bundle.");
  }
  const suiteRef = createEvaluationRecordRef(input.bundle.suiteRef);
  if (refKey(suiteRef) !== refKey(input.suite.suite.ref)) {
    throw new TypeError("Product-effectiveness Evidence bundle references another Suite revision.");
  }
  assertIsoTime(input.bundle.createdAt, "EvidenceBundle.createdAt");
  const cases = new Map(input.suite.cases.map((item) => [refKey(item.definition.ref), item]));
  const trialKeys = new Set<string>();
  const trials = input.bundle.trials.map((trial, index) => {
    const admitted = snapshotTrialEvidence(
      trial,
      input.bundle.targetName,
      targetSnapshot.ref,
      suiteRef,
      cases,
      `EvidenceBundle.trials[${index}]`,
    );
    const key = [
      admitted.targetName,
      refKey(admitted.caseRef),
      admitted.repetitionOrdinal,
    ].join(":");
    if (trialKeys.has(key)) {
      throw new TypeError(`Product-effectiveness Trial identity '${key}' is duplicated.`);
    }
    trialKeys.add(key);
    return admitted;
  }).sort(compareTrialEvidence);
  const limitations = snapshotStrings(input.bundle.limitations, "EvidenceBundle.limitations");
  const targetManifestDigest = digest(targetSnapshot.manifest);
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "helarc_product_effectiveness_evidence_bundle" as const,
    targetName: input.bundle.targetName,
    targetSnapshot,
    targetManifestDigest,
    suiteRef,
    trials: Object.freeze(trials),
    createdAt: input.bundle.createdAt,
    limitations,
  };
  return deepFreeze({
    ...unsigned,
    bundleDigest: digest(unsigned),
  });
}

export function importHelarcProductEffectivenessEvidenceBundle(input: {
  readonly json: string;
  readonly objective: EvaluationObjective;
  readonly suite: HelarcProductEffectivenessSuiteProfile;
}): HelarcProductEffectivenessEvidenceBundle {
  let value: unknown;
  try {
    value = JSON.parse(input.json);
  } catch {
    throw new TypeError("Product-effectiveness Evidence bundle is not valid JSON.");
  }
  const record = requireRecord(value, "EvidenceBundle");
  const declaredDigest = requireString(record.bundleDigest, "EvidenceBundle.bundleDigest");
  const admitted = sealHelarcProductEffectivenessEvidenceBundle({
    objective: input.objective,
    suite: input.suite,
    bundle: {
      targetName: record.targetName as HelarcProductEffectivenessTargetName,
      targetSnapshot: record.targetSnapshot as EvaluationTargetSnapshot,
      suiteRef: record.suiteRef as EvaluationRecordRef,
      trials: record.trials as readonly HelarcProductEffectivenessTrialEvidence[],
      createdAt: record.createdAt as string,
      limitations: record.limitations as readonly string[],
    },
  });
  if (admitted.bundleDigest !== declaredDigest) {
    throw new TypeError("Product-effectiveness Evidence bundle digest does not match its normalized content.");
  }
  if (record.targetManifestDigest !== admitted.targetManifestDigest) {
    throw new TypeError("Product-effectiveness Target Snapshot manifest digest does not match its normalized content.");
  }
  return admitted;
}

function snapshotTrialEvidence(
  input: HelarcProductEffectivenessTrialEvidence,
  targetName: HelarcProductEffectivenessTargetName,
  targetSnapshotRef: EvaluationRecordRef,
  suiteRef: EvaluationRecordRef,
  cases: ReadonlyMap<string, HelarcProductEffectivenessCaseProfile>,
  path: string,
): HelarcProductEffectivenessTrialEvidence {
  const ref = createEvaluationRecordRef(input?.ref, `${path}.ref`);
  if (input.targetName !== targetName) {
    throw new TypeError(`${path}.targetName does not match the Evidence bundle.`);
  }
  if (refKey(input.targetSnapshotRef) !== refKey(targetSnapshotRef)) {
    throw new TypeError(`${path}.targetSnapshotRef does not match the Evidence bundle.`);
  }
  if (refKey(input.suiteRef) !== refKey(suiteRef)) {
    throw new TypeError(`${path}.suiteRef does not match the Evidence bundle.`);
  }
  const caseRef = createEvaluationRecordRef(input.caseRef, `${path}.caseRef`);
  const caseProfile = cases.get(refKey(caseRef));
  if (caseProfile === undefined) throw new TypeError(`${path}.caseRef is not admitted by the Suite.`);
  if (!Number.isInteger(input.repetitionOrdinal) ||
      input.repetitionOrdinal < 1 ||
      input.repetitionOrdinal > HELARC_PRODUCT_EFFECTIVENESS_REPETITIONS) {
    throw new TypeError(`${path}.repetitionOrdinal is outside the admitted repetition schedule.`);
  }
  const expectedPairingKey = `${caseProfile.definition.pairingKey}.rep-${input.repetitionOrdinal}`;
  if (input.pairingKey !== expectedPairingKey) {
    throw new TypeError(`${path}.pairingKey does not match Case and repetition identity.`);
  }
  if (!(["completed", "excluded", "unavailable", "invalid", "incomparable"] as const)
    .includes(input.status)) {
    throw new TypeError(`${path}.status is unsupported.`);
  }
  const safety = snapshotSafety(input.safety, path);
  const exclusion = snapshotExclusion(input.exclusion, input.status, path);
  if (input.status === "completed") {
    assertUnitInterval(input.outcomeScore, `${path}.outcomeScore`);
    if (Object.values(safety).some((value) => typeof value !== "boolean")) {
      throw new TypeError(`${path}.safety must be complete for a completed Trial.`);
    }
  } else if (input.outcomeScore !== null) {
    throw new TypeError(`${path}.outcomeScore must be null when the Trial is not completed.`);
  }
  const diagnostics = snapshotDiagnostics(input.diagnostics, path);
  const provenance = snapshotProvenance(input.provenance, targetName, path);
  const limitations = snapshotStrings(input.limitations, `${path}.limitations`);
  return deepFreeze({
    ref,
    targetName,
    targetSnapshotRef,
    suiteRef,
    caseRef,
    repetitionOrdinal: input.repetitionOrdinal,
    pairingKey: input.pairingKey,
    status: input.status,
    outcomeScore: input.outcomeScore,
    safety,
    diagnostics,
    exclusion,
    provenance,
    limitations,
  });
}

function snapshotSafety(
  input: HelarcProductEffectivenessTrialEvidence["safety"],
  path: string,
): HelarcProductEffectivenessTrialEvidence["safety"] {
  const record = requireRecord(input, `${path}.safety`);
  const result: Record<string, boolean | null> = {};
  const admitted = new Set<string>(HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates);
  if (Object.keys(record).length !== admitted.size) {
    throw new TypeError(`${path}.safety must contain every and only the admitted safety gate.`);
  }
  for (const gate of HELARC_PRODUCT_EFFECTIVENESS_PROTOCOL.absoluteSafetyGates) {
    const value = record[gate];
    if (value !== true && value !== false && value !== null) {
      throw new TypeError(`${path}.safety.${gate} must be boolean or null.`);
    }
    result[gate] = value;
    admitted.delete(gate);
  }
  if (admitted.size > 0) throw new TypeError(`${path}.safety is incomplete.`);
  return Object.freeze(result) as HelarcProductEffectivenessTrialEvidence["safety"];
}

function snapshotDiagnostics(
  input: HelarcProductEffectivenessDiagnostics,
  path: string,
): HelarcProductEffectivenessDiagnostics {
  const values = requireRecord(input, `${path}.diagnostics`);
  const expectedKeys: readonly (keyof HelarcProductEffectivenessDiagnostics)[] = [
    "trajectoryScore",
    "verificationScore",
    "latencyMs",
    "inputTokens",
    "outputTokens",
    "estimatedCost",
    "toolCalls",
    "retries",
    "humanInteractionEvents",
  ];
  if (Object.keys(values).sort().join("|") !== [...expectedKeys].sort().join("|")) {
    throw new TypeError(`${path}.diagnostics must contain the exact admitted measurements.`);
  }
  assertNullableUnitInterval(values.trajectoryScore, `${path}.diagnostics.trajectoryScore`);
  assertNullableUnitInterval(values.verificationScore, `${path}.diagnostics.verificationScore`);
  assertNullableNonNegative(values.latencyMs, false, `${path}.diagnostics.latencyMs`);
  assertNullableNonNegative(values.inputTokens, true, `${path}.diagnostics.inputTokens`);
  assertNullableNonNegative(values.outputTokens, true, `${path}.diagnostics.outputTokens`);
  assertNullableNonNegative(values.estimatedCost, false, `${path}.diagnostics.estimatedCost`);
  assertNullableNonNegative(values.toolCalls, true, `${path}.diagnostics.toolCalls`);
  assertNullableNonNegative(values.retries, true, `${path}.diagnostics.retries`);
  assertNullableNonNegative(
    values.humanInteractionEvents,
    true,
    `${path}.diagnostics.humanInteractionEvents`,
  );
  return Object.freeze({
    trajectoryScore: values.trajectoryScore as number | null,
    verificationScore: values.verificationScore as number | null,
    latencyMs: values.latencyMs as number | null,
    inputTokens: values.inputTokens as number | null,
    outputTokens: values.outputTokens as number | null,
    estimatedCost: values.estimatedCost as number | null,
    toolCalls: values.toolCalls as number | null,
    retries: values.retries as number | null,
    humanInteractionEvents: values.humanInteractionEvents as number | null,
  });
}

function snapshotProvenance(
  input: HelarcProductEffectivenessTrialProvenance,
  targetName: HelarcProductEffectivenessTargetName,
  path: string,
): HelarcProductEffectivenessTrialProvenance {
  if (input.executionSource !== (targetName === "codex" ? "imported" : "captured")) {
    throw new TypeError(`${path}.provenance.executionSource is not admitted for ${targetName}.`);
  }
  const productVersion = requireString(input.productVersion, `${path}.provenance.productVersion`);
  const model = requireString(input.model, `${path}.provenance.model`);
  const environment = requireString(input.environment, `${path}.provenance.environment`);
  if (!(["deterministic", "reference", "human_input", "hosted_model"] as const)
    .includes(input.graderKind)) {
    throw new TypeError(`${path}.provenance.graderKind is unsupported.`);
  }
  const graderRevision = requireString(input.graderRevision, `${path}.provenance.graderRevision`);
  assertIsoTime(input.capturedAt, `${path}.provenance.capturedAt`);
  assertSha256(input.sourceArtifactDigest, `${path}.provenance.sourceArtifactDigest`);
  if (input.scriptedProviderOutput !== false) {
    throw new TypeError(`${path}.provenance cannot admit scripted Provider output.`);
  }
  const metadata = snapshotDataObject(input.metadata, `${path}.provenance.metadata`);
  assertSafeEvidenceProjection(metadata, `${path}.provenance.metadata`);
  return Object.freeze({
    executionSource: input.executionSource,
    productVersion,
    model,
    environment,
    graderKind: input.graderKind,
    graderRevision,
    capturedAt: input.capturedAt,
    sourceArtifactDigest: input.sourceArtifactDigest,
    scriptedProviderOutput: false,
    metadata,
  });
}

function snapshotExclusion(
  input: HelarcProductEffectivenessTrialEvidence["exclusion"],
  status: HelarcProductEffectivenessTrialStatus,
  path: string,
) {
  if (status === "completed") {
    if (input !== null) throw new TypeError(`${path}.exclusion must be null for a completed Trial.`);
    return null;
  }
  const record = requireRecord(input, `${path}.exclusion`);
  return Object.freeze({
    code: requireToken(record.code, `${path}.exclusion.code`),
    reason: requireString(record.reason, `${path}.exclusion.reason`),
  });
}

function compareTrialEvidence(
  left: HelarcProductEffectivenessTrialEvidence,
  right: HelarcProductEffectivenessTrialEvidence,
): number {
  return `${refKey(left.caseRef)}:${left.repetitionOrdinal}`.localeCompare(
    `${refKey(right.caseRef)}:${right.repetitionOrdinal}`,
  );
}

function assertTargetName(value: unknown): asserts value is HelarcProductEffectivenessTargetName {
  if (value !== "codex" && value !== "helarc") {
    throw new TypeError("EvidenceBundle.targetName is unsupported.");
  }
}

function assertUnitInterval(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${path} must be a finite number from zero through one.`);
  }
}

function assertNullableUnitInterval(value: unknown, path: string): void {
  if (value !== null) assertUnitInterval(value, path);
}

function assertNullableNonNegative(value: unknown, integer: boolean, path: string): void {
  if (value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (integer && !Number.isInteger(value))) {
    throw new TypeError(`${path} must be null or a finite non-negative${integer ? " integer" : " number"}.`);
  }
}

function assertSha256(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${path} must be a canonical sha256 digest.`);
  }
}

function assertIsoTime(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO timestamp.`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireToken(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw new TypeError(`${path} must be a token.`);
  }
  return text;
}

function snapshotStrings(input: readonly string[], path: string): readonly string[] {
  if (!Array.isArray(input)) throw new TypeError(`${path} must be an array.`);
  return Object.freeze(input.map((item, index) => requireString(item, `${path}[${index}]`)));
}

function snapshotDataObject(input: unknown, path: string): EvaluationDataObject {
  const value = snapshotEvaluationData(input, path);
  if (!isDataObject(value)) {
    throw new TypeError(`${path} must be an Evaluation data object.`);
  }
  return value;
}

function isDataObject(value: unknown): value is EvaluationDataObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeEvidenceProjection(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^file:\/\//i.test(value) ||
        /^\/(?:tmp|home|users|var|private|opt|etc)(?:\/|$)/i.test(value)) {
      throw new TypeError(`${path} contains a physical filesystem path.`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvidenceProjection(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:prompt|systemPrompt|userPrompt|credential|credentials|password|secret|apiKey|accessToken|refreshToken|bearerToken|tokenValue|physicalRoot|rootPath|fileHandle|runState|rendererState)$/i.test(key)) {
      throw new TypeError(`${path}.${key} is not admitted in Product-effectiveness Evidence.`);
    }
    assertSafeEvidenceProjection(child, `${path}.${key}`);
  }
}

function refKey(ref: EvaluationRecordRef): string {
  return `${ref.id}@${ref.revision}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
