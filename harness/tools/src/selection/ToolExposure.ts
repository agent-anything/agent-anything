import type { ToolCatalogSnapshot, ToolDescriptor } from "../catalog/index.js";
import { createToolCatalogSnapshot } from "../catalog/index.js";
import type { ToolBindingRef, ToolRevisionRef } from "../identity/index.js";
import { createToolContractIdentity, toolRevisionKey } from "../identity/index.js";
import {
  createStaticAvailableToolBindingAssessment,
  snapshotToolBindingAvailabilityAssessment,
  snapshotToolBindingRef,
  snapshotToolExposureBasisRefs,
  toolBindingIdentity,
  toolExposureBasisRefKey,
  ToolExposureValidationError,
  type ToolBindingAvailabilityAssessment,
  type ToolBindingUnavailableReason,
  type ToolExposureBasisRef,
} from "./ToolAvailability.js";
import {
  snapshotToolSelectionRevision,
  type SelectedTool,
  type ToolSelectionRevision,
} from "./ToolSelection.js";

export const TOOL_EXPOSURE_RESOLVER_REVISION = "agent-anything.current-turn-tool-exposure.v1";

export interface ToolExposureBasis {
  readonly schemaVersion: 1;
  readonly consumer: "controller";
  readonly selectionRevision: string;
  readonly algorithmRevision: typeof TOOL_EXPOSURE_RESOLVER_REVISION;
  readonly refs: readonly ToolExposureBasisRef[];
  readonly assessmentRevisions: readonly string[];
  readonly revision: string;
}

export interface ToolExposureOmission {
  readonly tool: ToolRevisionRef;
  readonly binding: ToolBindingRef;
  readonly assessmentRevision: string;
  readonly reason: ToolBindingUnavailableReason;
}

export interface CurrentTurnToolExposure {
  readonly schemaVersion: 1;
  readonly selectionRevision: string;
  readonly basis: ToolExposureBasis;
  readonly exposedTools: readonly ToolRevisionRef[];
  readonly catalog: ToolCatalogSnapshot;
  readonly omissions: readonly ToolExposureOmission[];
  readonly contentRevision: string;
}

export interface ToolExposureProof {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly selectionRevision: string;
  readonly contentRevision: string;
  readonly basisRevision: string;
  readonly consumer: "controller";
  readonly controllerRequestId: string;
  readonly exposedTools: readonly ToolRevisionRef[];
  readonly catalog: ToolCatalogSnapshot;
}

export interface ResolveCurrentTurnToolExposureInput {
  readonly basisRefs: readonly ToolExposureBasisRef[];
  readonly assessments: readonly ToolBindingAvailabilityAssessment[];
}

export function resolveCurrentTurnToolExposure(
  selectionInput: ToolSelectionRevision,
  input: ResolveCurrentTurnToolExposureInput,
): CurrentTurnToolExposure {
  if (input === null || typeof input !== "object") {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure resolution input must be an object.");
  }
  assertExactRecord(input, ["basisRefs", "assessments"], "Tool Exposure resolution input");
  const selection = snapshotToolSelectionRevision(selectionInput);
  const modelTools = selection.tools.filter((selected) => selected.origins.includes("model"));
  if (modelTools.some((selected) => selected.registration.descriptor.retirement !== null)) {
    throw exposureInvalid("tool_exposure_selection_invalid", "Current-turn exposure cannot include a retired selected Tool.");
  }
  const basisRefs = snapshotToolExposureBasisRefs(input.basisRefs);
  if (basisRefs.length === 0) {
    throw exposureInvalid("tool_exposure_basis_invalid", "Current-turn exposure requires at least one trusted basis reference.");
  }
  if (!Array.isArray(input.assessments)) {
    throw exposureInvalid("tool_availability_invalid", "Tool availability assessments must be an array.");
  }
  assertDenseArray(input.assessments, "Tool availability assessments");

  const selectedByKey = new Map(modelTools.map((selected) => [
    toolRevisionKey(selected.registration.descriptor.ref),
    selected,
  ]));
  const currentBasisKeys = new Set(basisRefs.map(toolExposureBasisRefKey));
  const assessmentByTool = new Map<string, ToolBindingAvailabilityAssessment>();
  for (const raw of input.assessments) {
    const assessment = snapshotToolBindingAvailabilityAssessment(raw);
    const key = toolRevisionKey(assessment.tool);
    const selected = selectedByKey.get(key);
    if (selected === undefined) {
      throw exposureInvalid(
        "tool_exposure_assessment_tool_invalid",
        `Availability assessment Tool '${key}' is not selected for model exposure.`,
      );
    }
    if (assessmentByTool.has(key)) {
      throw exposureInvalid(
        "tool_exposure_assessment_duplicate",
        `Availability assessment Tool '${key}' is duplicated.`,
      );
    }
    if (assessment.selectionRevision !== selection.revision) {
      throw exposureInvalid(
        "tool_exposure_assessment_selection_invalid",
        `Availability assessment Tool '${key}' targets a stale selection revision.`,
      );
    }
    if (toolBindingIdentity(assessment.binding) !== toolBindingIdentity(selected.registration.descriptor.binding)) {
      throw exposureInvalid(
        "tool_exposure_assessment_binding_invalid",
        `Availability assessment Tool '${key}' targets the wrong binding.`,
      );
    }
    if (assessment.basisRefs.some((ref) => !currentBasisKeys.has(toolExposureBasisRefKey(ref)))) {
      throw exposureInvalid(
        "tool_exposure_basis_stale",
        `Availability assessment Tool '${key}' does not match the current trusted basis.`,
      );
    }
    assessmentByTool.set(key, assessment);
  }

  const missing = modelTools
    .map((selected) => toolRevisionKey(selected.registration.descriptor.ref))
    .filter((key) => !assessmentByTool.has(key));
  if (missing.length > 0) {
    throw exposureInvalid(
      "tool_exposure_assessment_missing",
      `Current-turn exposure is missing availability for: ${missing.join(", ")}.`,
    );
  }

  const exposed: SelectedTool[] = [];
  const omissions: ToolExposureOmission[] = [];
  for (const selected of modelTools) {
    const descriptor = selected.registration.descriptor;
    const assessment = assessmentByTool.get(toolRevisionKey(descriptor.ref))!;
    if (assessment.disposition === "available") {
      exposed.push(selected);
    } else {
      omissions.push(Object.freeze({
        tool: descriptor.ref,
        binding: descriptor.binding,
        assessmentRevision: assessment.revision,
        reason: assessment.reason!,
      }));
    }
  }

  const exposedTools = Object.freeze(exposed.map((selected) => selected.registration.descriptor.ref));
  const catalog = createToolCatalogSnapshot(
    exposed.map((selected) => descriptorInput(selected.registration.descriptor)),
  );
  const frozenOmissions = Object.freeze(omissions);
  const assessmentRevisions = Object.freeze(
    [...assessmentByTool.values()].map((assessment) => assessment.revision).sort(),
  );
  const basis = createExposureBasis(selection.revision, basisRefs, assessmentRevisions);
  const contentRevision = exposureContentRevision({
    selectionRevision: selection.revision,
    exposedTools,
    catalogRevision: catalog.revision,
    omissions: frozenOmissions,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    selectionRevision: selection.revision,
    basis,
    exposedTools,
    catalog,
    omissions: frozenOmissions,
    contentRevision,
  });
}

export function createToolExposureProof(
  exposureInput: CurrentTurnToolExposure,
  controllerRequestId: string,
): ToolExposureProof {
  const exposure = snapshotCurrentTurnToolExposure(exposureInput);
  const base = {
    selectionRevision: exposure.selectionRevision,
    contentRevision: exposure.contentRevision,
    basisRevision: exposure.basis.revision,
    consumer: "controller" as const,
    controllerRequestId: token(controllerRequestId, "controllerRequestId"),
    exposedTools: exposure.exposedTools,
    catalog: exposure.catalog,
  };
  return Object.freeze({
    schemaVersion: 1 as const,
    id: proofIdentity(base),
    ...base,
  });
}

/** Fixed-exposure predecessor retained until Runner supplies owner availability. */
export function createFixedControllerToolExposureProof(
  selection: ToolSelectionRevision,
  controllerRequestId: string,
): ToolExposureProof {
  const snapshot = snapshotToolSelectionRevision(selection);
  const modelTools = snapshot.tools.filter((selected) => selected.origins.includes("model"));
  const assessments = modelTools.map((selected) =>
    createStaticAvailableToolBindingAssessment(snapshot, selected.registration.descriptor.ref)
  );
  const basisRefs = snapshotToolExposureBasisRefs([
    {
      owner: "tools",
      kind: "fixed_selection",
      id: snapshot.selectionId,
      revision: snapshot.revision,
    },
    ...assessments.flatMap((assessment) => assessment.basisRefs),
  ]);
  return createToolExposureProof(
    resolveCurrentTurnToolExposure(snapshot, { basisRefs, assessments }),
    controllerRequestId,
  );
}

export function snapshotCurrentTurnToolExposure(
  input: CurrentTurnToolExposure,
): CurrentTurnToolExposure {
  if (input === null || typeof input !== "object" || input.schemaVersion !== 1) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Current-turn Tool Exposure must use schema version 1.");
  }
  assertExactRecord(input, [
    "schemaVersion",
    "selectionRevision",
    "basis",
    "exposedTools",
    "catalog",
    "omissions",
    "contentRevision",
  ], "Current-turn Tool Exposure");
  const selectionRevision = token(input.selectionRevision, "selectionRevision");
  const basis = snapshotExposureBasis(input.basis);
  if (basis.selectionRevision !== selectionRevision) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure basis targets the wrong selection revision.");
  }
  const catalog = snapshotCatalog(input.catalog);
  const exposedTools = snapshotToolRefs(input.exposedTools);
  if (
    exposedTools.length !== catalog.tools.length ||
    exposedTools.some((ref, index) => toolRevisionKey(ref) !== toolRevisionKey(catalog.tools[index]!.ref))
  ) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure revisions do not match the exact Catalog.");
  }
  const omissions = snapshotOmissions(input.omissions);
  const visible = new Set(exposedTools.map(toolRevisionKey));
  if (omissions.some((omission) => visible.has(toolRevisionKey(omission.tool)))) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "A Tool cannot be both exposed and omitted.");
  }
  const assessmentRevisions = new Set(basis.assessmentRevisions);
  if (
    basis.assessmentRevisions.length !== exposedTools.length + omissions.length ||
    omissions.some((omission) => !assessmentRevisions.has(omission.assessmentRevision))
  ) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure assessment lineage is incomplete.");
  }
  const expectedContentRevision = exposureContentRevision({
    selectionRevision,
    exposedTools,
    catalogRevision: catalog.revision,
    omissions,
  });
  if (token(input.contentRevision, "contentRevision") !== expectedContentRevision) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure content revision is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    selectionRevision,
    basis,
    exposedTools,
    catalog,
    omissions,
    contentRevision: expectedContentRevision,
  });
}

export function snapshotToolExposureProof(input: ToolExposureProof): ToolExposureProof {
  if (input === null || typeof input !== "object" || input.schemaVersion !== 1) {
    throw exposureInvalid("tool_exposure_proof_invalid", "Tool Exposure proof must use schema version 1.");
  }
  assertExactRecord(input, [
    "schemaVersion",
    "id",
    "selectionRevision",
    "contentRevision",
    "basisRevision",
    "consumer",
    "controllerRequestId",
    "exposedTools",
    "catalog",
  ], "Tool Exposure proof");
  const base = {
    selectionRevision: token(input.selectionRevision, "selectionRevision"),
    contentRevision: token(input.contentRevision, "contentRevision"),
    basisRevision: token(input.basisRevision, "basisRevision"),
    consumer: consumer(input.consumer),
    controllerRequestId: token(input.controllerRequestId, "controllerRequestId"),
    exposedTools: snapshotToolRefs(input.exposedTools),
    catalog: snapshotCatalog(input.catalog),
  };
  if (
    base.exposedTools.length !== base.catalog.tools.length ||
    base.exposedTools.some((ref, index) => toolRevisionKey(ref) !== toolRevisionKey(base.catalog.tools[index]!.ref))
  ) {
    throw exposureInvalid("tool_exposure_proof_invalid", "Tool Exposure proof does not match its exact Catalog.");
  }
  const expectedId = proofIdentity(base);
  if (token(input.id, "id") !== expectedId) {
    throw exposureInvalid("tool_exposure_proof_invalid", "Tool Exposure proof identity is invalid.");
  }
  return Object.freeze({ schemaVersion: 1 as const, id: expectedId, ...base });
}

function createExposureBasis(
  selectionRevision: string,
  refs: readonly ToolExposureBasisRef[],
  assessmentRevisions: readonly string[],
): ToolExposureBasis {
  const base = {
    consumer: "controller" as const,
    selectionRevision,
    algorithmRevision: TOOL_EXPOSURE_RESOLVER_REVISION,
    refs,
    assessmentRevisions,
  } as const;
  return Object.freeze({
    schemaVersion: 1 as const,
    ...base,
    revision: createToolContractIdentity("agent-anything.tool-exposure-basis.v1", base),
  });
}

function snapshotExposureBasis(input: ToolExposureBasis): ToolExposureBasis {
  if (input === null || typeof input !== "object" || input.schemaVersion !== 1) {
    throw exposureInvalid("tool_exposure_basis_invalid", "Tool Exposure basis must use schema version 1.");
  }
  assertExactRecord(input, [
    "schemaVersion",
    "consumer",
    "selectionRevision",
    "algorithmRevision",
    "refs",
    "assessmentRevisions",
    "revision",
  ], "Tool Exposure basis");
  if (input.algorithmRevision !== TOOL_EXPOSURE_RESOLVER_REVISION) {
    throw exposureInvalid("tool_exposure_basis_invalid", "Tool Exposure basis uses an unsupported resolver revision.");
  }
  if (!Array.isArray(input.assessmentRevisions)) {
    throw exposureInvalid("tool_exposure_basis_invalid", "Tool Exposure assessment revisions must be an array.");
  }
  assertDenseArray(input.assessmentRevisions, "Tool Exposure assessment revisions");
  const assessmentRevisions = input.assessmentRevisions.map((value) => token(value, "assessmentRevision")).sort();
  if (new Set(assessmentRevisions).size !== assessmentRevisions.length) {
    throw exposureInvalid("tool_exposure_basis_invalid", "Tool Exposure assessment revisions must be unique.");
  }
  const base = {
    consumer: consumer(input.consumer),
    selectionRevision: token(input.selectionRevision, "selectionRevision"),
    algorithmRevision: TOOL_EXPOSURE_RESOLVER_REVISION,
    refs: snapshotToolExposureBasisRefs(input.refs),
    assessmentRevisions: Object.freeze(assessmentRevisions),
  } as const;
  const expectedRevision = createToolContractIdentity("agent-anything.tool-exposure-basis.v1", base);
  if (token(input.revision, "revision") !== expectedRevision) {
    throw exposureInvalid("tool_exposure_basis_invalid", "Tool Exposure basis identity is invalid.");
  }
  return Object.freeze({ schemaVersion: 1 as const, ...base, revision: expectedRevision });
}

function snapshotCatalog(input: ToolCatalogSnapshot): ToolCatalogSnapshot {
  if (input === null || typeof input !== "object" || !Array.isArray(input.tools)) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure requires an exact Tool Catalog.");
  }
  const catalog = createToolCatalogSnapshot(input.tools.map(descriptorInput));
  if (catalog.catalogId !== input.catalogId || catalog.revision !== input.revision) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure Catalog identity is invalid.");
  }
  return catalog;
}

function snapshotToolRefs(input: readonly ToolRevisionRef[]): readonly ToolRevisionRef[] {
  if (!Array.isArray(input)) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure revisions must be an array.");
  }
  assertDenseArray(input, "Tool Exposure revisions");
  const refs = input.map((ref) => {
    if (ref === null || typeof ref !== "object" || ref.tool === null || typeof ref.tool !== "object") {
      throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure requires exact Tool revision references.");
    }
    return Object.freeze({
      tool: Object.freeze({
        namespace: token(ref.tool.namespace, "tool.namespace"),
        name: token(ref.tool.name, "tool.name"),
      }),
      revision: token(ref.revision, "tool.revision"),
    });
  });
  refs.sort((left, right) => toolRevisionKey(left).localeCompare(toolRevisionKey(right)));
  if (new Set(refs.map(toolRevisionKey)).size !== refs.length) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure revisions must be unique.");
  }
  return Object.freeze(refs);
}

function snapshotOmissions(input: readonly ToolExposureOmission[]): readonly ToolExposureOmission[] {
  if (!Array.isArray(input)) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure omissions must be an array.");
  }
  assertDenseArray(input, "Tool Exposure omissions");
  const omissions = input.map((omission) => {
    if (omission === null || typeof omission !== "object") {
      throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure omission must be an object.");
    }
    assertExactRecord(omission, ["tool", "binding", "assessmentRevision", "reason"], "Tool Exposure omission");
    const reason = omission.reason;
    if (!UNAVAILABLE_REASONS.includes(reason)) {
      throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure omission reason is invalid.");
    }
    return Object.freeze({
      tool: snapshotToolRefs([omission.tool])[0]!,
      binding: snapshotToolBindingRef(omission.binding),
      assessmentRevision: token(omission.assessmentRevision, "assessmentRevision"),
      reason,
    });
  });
  omissions.sort((left, right) => toolRevisionKey(left.tool).localeCompare(toolRevisionKey(right.tool)));
  if (new Set(omissions.map((omission) => toolRevisionKey(omission.tool))).size !== omissions.length) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", "Tool Exposure omissions must be unique.");
  }
  return Object.freeze(omissions);
}

function exposureContentRevision(input: {
  readonly selectionRevision: string;
  readonly exposedTools: readonly ToolRevisionRef[];
  readonly catalogRevision: string;
  readonly omissions: readonly ToolExposureOmission[];
}): string {
  return createToolContractIdentity("agent-anything.current-turn-tool-exposure-content.v1", {
    selectionRevision: input.selectionRevision,
    exposedTools: input.exposedTools,
    catalogRevision: input.catalogRevision,
    omissions: input.omissions.map((omission) => ({
      tool: omission.tool,
      reason: omission.reason,
    })),
  });
}

function proofIdentity(input: {
  readonly selectionRevision: string;
  readonly contentRevision: string;
  readonly basisRevision: string;
  readonly consumer: "controller";
  readonly controllerRequestId: string;
  readonly exposedTools: readonly ToolRevisionRef[];
  readonly catalog: ToolCatalogSnapshot;
}): string {
  return createToolContractIdentity("agent-anything.controller-tool-exposure-proof.v2", {
    selectionRevision: input.selectionRevision,
    contentRevision: input.contentRevision,
    basisRevision: input.basisRevision,
    consumer: input.consumer,
    controllerRequestId: input.controllerRequestId,
    exposedTools: input.exposedTools,
    catalogRevision: input.catalog.revision,
  });
}

function descriptorInput(descriptor: ToolDescriptor) {
  const { fingerprint: _fingerprint, ...input } = descriptor;
  return input;
}

function consumer(input: unknown): "controller" {
  if (input !== "controller") {
    throw exposureInvalid("tool_exposure_proof_invalid", "Tool Exposure consumer must be controller.");
  }
  return input;
}

function token(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    input !== input.trim()
  ) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", `${field} must be a bounded canonical token.`);
  }
  return input;
}

function exposureInvalid(
  code: ConstructorParameters<typeof ToolExposureValidationError>[0],
  message: string,
): ToolExposureValidationError {
  return new ToolExposureValidationError(code, message);
}

const UNAVAILABLE_REASONS: readonly ToolBindingUnavailableReason[] = Object.freeze([
  "binding_inactive",
  "execution_path_unavailable",
  "resource_exhausted",
  "no_eligible_subject",
  "interaction_capacity_exhausted",
  "descendant_capacity_exhausted",
]);

function assertExactRecord(
  input: object,
  allowed: readonly string[],
  name: string,
): void {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", `${name} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw exposureInvalid("tool_exposure_snapshot_invalid", `${name} contains an unsupported field.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw exposureInvalid("tool_exposure_snapshot_invalid", `${name} cannot contain accessors.`);
    }
  }
}

function assertDenseArray(input: readonly unknown[], name: string): void {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      throw exposureInvalid("tool_exposure_snapshot_invalid", `${name} cannot contain sparse entries.`);
    }
  }
}
