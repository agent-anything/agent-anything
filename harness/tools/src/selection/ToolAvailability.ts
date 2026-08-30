import type { ToolBindingRef, ToolRevisionRef } from "../identity/index.js";
import { createToolContractIdentity, toolRevisionKey } from "../identity/index.js";
import { findSelectedTool, type ToolSelectionRevision } from "./ToolSelection.js";

export type ToolBindingAvailabilityDisposition = "available" | "unavailable";

export type ToolBindingUnavailableReason =
  | "binding_inactive"
  | "execution_path_unavailable"
  | "resource_exhausted"
  | "no_eligible_subject"
  | "interaction_capacity_exhausted"
  | "descendant_capacity_exhausted";

export interface ToolExposureBasisRef {
  readonly owner: string;
  readonly kind: string;
  readonly id: string;
  readonly revision: string;
}

export interface ToolBindingAvailabilityAssessment {
  readonly schemaVersion: 1;
  readonly tool: ToolRevisionRef;
  readonly binding: ToolBindingRef;
  readonly selectionRevision: string;
  readonly basisRefs: readonly ToolExposureBasisRef[];
  readonly disposition: ToolBindingAvailabilityDisposition;
  readonly reason: ToolBindingUnavailableReason | null;
  readonly revision: string;
}

export type ToolExposureValidationCode =
  | "tool_availability_invalid"
  | "tool_availability_reason_invalid"
  | "tool_availability_revision_invalid"
  | "tool_exposure_basis_invalid"
  | "tool_exposure_basis_stale"
  | "tool_exposure_assessment_duplicate"
  | "tool_exposure_assessment_missing"
  | "tool_exposure_assessment_tool_invalid"
  | "tool_exposure_assessment_binding_invalid"
  | "tool_exposure_assessment_selection_invalid"
  | "tool_exposure_selection_invalid"
  | "tool_exposure_snapshot_invalid"
  | "tool_exposure_proof_invalid";

export class ToolExposureValidationError extends TypeError {
  constructor(
    readonly code: ToolExposureValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolExposureValidationError";
  }
}

export function createToolBindingAvailabilityAssessment(input: {
  readonly selection: ToolSelectionRevision;
  readonly tool: ToolRevisionRef;
  readonly basisRefs: readonly ToolExposureBasisRef[];
  readonly disposition: ToolBindingAvailabilityDisposition;
  readonly reason: ToolBindingUnavailableReason | null;
}): ToolBindingAvailabilityAssessment {
  const selected = findSelectedTool(input.selection, input.tool, "model");
  if (selected === undefined) {
    throw invalid(
      "tool_exposure_assessment_tool_invalid",
      `Tool revision '${toolRevisionKey(input.tool)}' is not selected for model exposure.`,
    );
  }
  return createAssessment({
    tool: selected.registration.descriptor.ref,
    binding: selected.registration.descriptor.binding,
    selectionRevision: input.selection.revision,
    basisRefs: snapshotToolExposureBasisRefs(input.basisRefs),
    disposition: input.disposition,
    reason: input.reason,
  });
}

export function createStaticAvailableToolBindingAssessment(
  selection: ToolSelectionRevision,
  tool: ToolRevisionRef,
): ToolBindingAvailabilityAssessment {
  const selected = findSelectedTool(selection, tool, "model");
  if (selected === undefined) {
    throw invalid(
      "tool_exposure_assessment_tool_invalid",
      `Tool revision '${toolRevisionKey(tool)}' is not selected for model exposure.`,
    );
  }
  const bindingRevision = createToolContractIdentity(
    "agent-anything.tool-binding.v1",
    selected.registration.descriptor.binding,
  );
  return createToolBindingAvailabilityAssessment({
    selection,
    tool,
    basisRefs: [{
      owner: "tools",
      kind: "static_binding",
      id: toolRevisionKey(tool),
      revision: bindingRevision,
    }],
    disposition: "available",
    reason: null,
  });
}

export function snapshotToolBindingAvailabilityAssessment(
  input: ToolBindingAvailabilityAssessment,
): ToolBindingAvailabilityAssessment {
  if (input === null || typeof input !== "object" || input.schemaVersion !== 1) {
    throw invalid("tool_availability_invalid", "Tool availability assessment must use schema version 1.");
  }
  assertExactRecord(input, [
    "schemaVersion",
    "tool",
    "binding",
    "selectionRevision",
    "basisRefs",
    "disposition",
    "reason",
    "revision",
  ], "Tool availability assessment");
  const basisRefs = snapshotToolExposureBasisRefs(input.basisRefs);
  if (basisRefs.length === 0) {
    throw invalid("tool_exposure_basis_invalid", "Tool availability assessment requires owner basis references.");
  }
  const base = {
    tool: snapshotToolRevisionRef(input.tool),
    binding: snapshotToolBindingRef(input.binding),
    selectionRevision: token(input.selectionRevision, "selectionRevision"),
    basisRefs,
    disposition: disposition(input.disposition),
    reason: unavailableReason(input.reason, input.disposition),
  } as const;
  const expectedRevision = assessmentRevision(base);
  if (token(input.revision, "revision") !== expectedRevision) {
    throw invalid(
      "tool_availability_revision_invalid",
      "Tool availability assessment revision does not match its immutable contents.",
    );
  }
  return Object.freeze({ schemaVersion: 1 as const, ...base, revision: expectedRevision });
}

export function snapshotToolExposureBasisRefs(
  input: readonly ToolExposureBasisRef[],
): readonly ToolExposureBasisRef[] {
  if (!Array.isArray(input) || input.length > 512) {
    throw invalid("tool_exposure_basis_invalid", "Tool exposure basis requires a bounded reference array.");
  }
  assertDenseArray(input, "Tool exposure basis");
  const seen = new Set<string>();
  const refs = input.map((ref) => {
    if (ref === null || typeof ref !== "object") {
      throw invalid("tool_exposure_basis_invalid", "Tool exposure basis references must be objects.");
    }
    assertExactRecord(ref, ["owner", "kind", "id", "revision"], "Tool exposure basis reference");
    const snapshot = Object.freeze({
      owner: token(ref.owner, "basis.owner"),
      kind: token(ref.kind, "basis.kind"),
      id: token(ref.id, "basis.id"),
      revision: token(ref.revision, "basis.revision"),
    });
    const key = toolExposureBasisRefKey(snapshot);
    if (seen.has(key)) {
      throw invalid("tool_exposure_basis_invalid", `Tool exposure basis reference '${key}' is duplicated.`);
    }
    seen.add(key);
    return snapshot;
  });
  refs.sort((left, right) => toolExposureBasisRefKey(left).localeCompare(toolExposureBasisRefKey(right)));
  return Object.freeze(refs);
}

export function toolExposureBasisRefKey(ref: ToolExposureBasisRef): string {
  return `${ref.owner}/${ref.kind}/${ref.id}@${ref.revision}`;
}

export function toolBindingIdentity(binding: ToolBindingRef): string {
  return createToolContractIdentity("agent-anything.tool-binding.v1", binding);
}

function createAssessment(input: {
  readonly tool: ToolRevisionRef;
  readonly binding: ToolBindingRef;
  readonly selectionRevision: string;
  readonly basisRefs: readonly ToolExposureBasisRef[];
  readonly disposition: ToolBindingAvailabilityDisposition;
  readonly reason: ToolBindingUnavailableReason | null;
}): ToolBindingAvailabilityAssessment {
  const basisRefs = snapshotToolExposureBasisRefs(input.basisRefs);
  if (basisRefs.length === 0) {
    throw invalid("tool_exposure_basis_invalid", "Tool availability assessment requires owner basis references.");
  }
  const base = {
    tool: snapshotToolRevisionRef(input.tool),
    binding: snapshotToolBindingRef(input.binding),
    selectionRevision: token(input.selectionRevision, "selectionRevision"),
    basisRefs,
    disposition: disposition(input.disposition),
    reason: unavailableReason(input.reason, input.disposition),
  } as const;
  return Object.freeze({
    schemaVersion: 1 as const,
    ...base,
    revision: assessmentRevision(base),
  });
}

function assessmentRevision(input: {
  readonly tool: ToolRevisionRef;
  readonly binding: ToolBindingRef;
  readonly selectionRevision: string;
  readonly basisRefs: readonly ToolExposureBasisRef[];
  readonly disposition: ToolBindingAvailabilityDisposition;
  readonly reason: ToolBindingUnavailableReason | null;
}): string {
  return createToolContractIdentity("agent-anything.tool-binding-availability.v1", input);
}

function snapshotToolRevisionRef(input: ToolRevisionRef): ToolRevisionRef {
  if (input === null || typeof input !== "object" || input.tool === null || typeof input.tool !== "object") {
    throw invalid("tool_availability_invalid", "Tool availability requires an exact Tool revision reference.");
  }
  assertExactRecord(input, ["tool", "revision"], "Tool revision reference");
  assertExactRecord(input.tool, ["namespace", "name"], "Tool key");
  return Object.freeze({
    tool: Object.freeze({
      namespace: token(input.tool.namespace, "tool.namespace"),
      name: token(input.tool.name, "tool.name"),
    }),
    revision: token(input.revision, "tool.revision"),
  });
}

export function snapshotToolBindingRef(input: ToolBindingRef): ToolBindingRef {
  if (input === null || typeof input !== "object") {
    throw invalid("tool_availability_invalid", "Tool availability requires an exact binding reference.");
  }
  switch (input.kind) {
    case "operation":
      assertExactRecord(input, ["kind", "operation", "revision"], "Tool operation binding");
      assertExactRecord(input.operation, ["operation", "revision"], "Operation revision reference");
      assertExactRecord(input.operation.operation, ["namespace", "name"], "Operation key");
      return Object.freeze({
        kind: "operation" as const,
        operation: Object.freeze({
          operation: Object.freeze({
            namespace: token(input.operation.operation.namespace, "binding.operation.namespace"),
            name: token(input.operation.operation.name, "binding.operation.name"),
          }),
          revision: token(input.operation.revision, "binding.operation.revision"),
        }),
        revision: token(input.revision, "binding.revision"),
      });
    case "interaction":
      assertExactRecord(input, ["kind", "protocol", "blockingScope", "revision"], "Tool interaction binding");
      assertExactRecord(input.protocol, ["owner", "kind", "revision"], "Interaction protocol reference");
      if (!["none", "branch", "run"].includes(input.blockingScope)) {
        throw invalid("tool_availability_invalid", "Tool interaction binding scope is invalid.");
      }
      return Object.freeze({
        kind: "interaction" as const,
        protocol: Object.freeze({
          owner: token(input.protocol.owner, "binding.protocol.owner"),
          kind: token(input.protocol.kind, "binding.protocol.kind"),
          revision: token(input.protocol.revision, "binding.protocol.revision"),
        }),
        blockingScope: input.blockingScope,
        revision: token(input.revision, "binding.revision"),
      });
    case "descendant_agent":
    case "descendant_message":
      assertExactRecord(input, ["kind", "agent", "revision"], "Tool descendant binding");
      assertExactRecord(input.agent, ["id", "revision"], "Agent revision reference");
      return Object.freeze({
        kind: input.kind,
        agent: Object.freeze({
          id: token(input.agent.id, "binding.agent.id"),
          revision: token(input.agent.revision, "binding.agent.revision"),
        }),
        revision: token(input.revision, "binding.revision"),
      });
    default:
      throw invalid("tool_availability_invalid", "Tool availability binding kind is unsupported.");
  }
}

function disposition(input: unknown): ToolBindingAvailabilityDisposition {
  if (input !== "available" && input !== "unavailable") {
    throw invalid("tool_availability_invalid", "Tool availability disposition is invalid.");
  }
  return input;
}

function unavailableReason(
  input: unknown,
  currentDisposition: ToolBindingAvailabilityDisposition,
): ToolBindingUnavailableReason | null {
  if (currentDisposition === "available") {
    if (input !== null) {
      throw invalid("tool_availability_reason_invalid", "An available Tool binding cannot carry an unavailable reason.");
    }
    return null;
  }
  if (!UNAVAILABLE_REASONS.includes(input as ToolBindingUnavailableReason)) {
    throw invalid("tool_availability_reason_invalid", "An unavailable Tool binding requires one bounded reason.");
  }
  return input as ToolBindingUnavailableReason;
}

function token(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    input !== input.trim()
  ) {
    throw invalid("tool_availability_invalid", `${field} must be a bounded canonical token.`);
  }
  return input;
}

function invalid(code: ToolExposureValidationCode, message: string): ToolExposureValidationError {
  return new ToolExposureValidationError(code, message);
}

function assertExactRecord(
  input: object,
  allowed: readonly string[],
  name: string,
): void {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("tool_availability_invalid", `${name} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw invalid("tool_availability_invalid", `${name} contains an unsupported field.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      throw invalid("tool_availability_invalid", `${name} cannot contain accessors.`);
    }
  }
}

function assertDenseArray(input: readonly unknown[], name: string): void {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      throw invalid("tool_availability_invalid", `${name} cannot contain sparse entries.`);
    }
  }
}

const UNAVAILABLE_REASONS: readonly ToolBindingUnavailableReason[] = Object.freeze([
  "binding_inactive",
  "execution_path_unavailable",
  "resource_exhausted",
  "no_eligible_subject",
  "interaction_capacity_exhausted",
  "descendant_capacity_exhausted",
]);
