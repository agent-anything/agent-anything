import type { OperationCatalogSnapshot } from "@agent-anything/operation-catalog/catalog";
import { operationRevisionKey } from "@agent-anything/operation-catalog/identity";
import type { ToolCatalogSnapshot, ToolDescriptor } from "../catalog/index.js";
import { createToolCatalogSnapshot } from "../catalog/index.js";
import { createToolContractIdentity, toolRevisionKey, type ToolRevisionRef } from "../identity/index.js";
import type { RegisteredTool, ToolRegistrationSnapshot } from "../registration/index.js";

export type ToolRequestOrigin = "model" | "workflow";

export interface ToolSelectionInput {
  readonly tool: ToolRevisionRef;
  readonly origins: readonly ToolRequestOrigin[];
}

export interface SelectedTool {
  readonly registration: RegisteredTool;
  readonly origins: readonly ToolRequestOrigin[];
}

export interface ToolSelectionRevision {
  readonly schemaVersion: 2;
  readonly selectionId: string;
  readonly revision: string;
  readonly toolCatalogId: string;
  readonly operationCatalogId: string;
  readonly operationCatalogRevision: string;
  readonly tools: readonly SelectedTool[];
}

export interface ToolExposureProof {
  readonly id: string;
  readonly selectionRevision: string;
  readonly consumer: "controller";
  readonly controllerRequestId: string;
  readonly exposedTools: readonly ToolRevisionRef[];
  readonly catalog: ToolCatalogSnapshot;
}

export class ToolSelectionValidationError extends TypeError {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolSelectionValidationError";
  }
}

export function createFixedLocalToolSelection(
  registrations: ToolRegistrationSnapshot,
  operationCatalog: OperationCatalogSnapshot,
  inputs: readonly ToolSelectionInput[],
): ToolSelectionRevision {
  if (registrations.operationCatalogId !== operationCatalog.id || registrations.operationCatalogRevision !== operationCatalog.revision) {
    throw invalid("tool_selection_catalog_mismatch", "Tool and Operation catalog snapshots do not match.");
  }
  const selectedKeys = new Set<string>();
  const tools = inputs.map((input) => {
    const key = toolRevisionKey(input.tool);
    if (selectedKeys.has(key)) throw invalid("tool_selection_duplicate", `Tool revision '${key}' is selected more than once.`);
    selectedKeys.add(key);
    const registration = registrations.registrations.find((candidate) => toolRevisionKey(candidate.descriptor.ref) === key);
    if (registration === undefined) throw invalid("tool_selection_unknown", `Tool revision '${key}' is not admitted.`);
    if (registration.descriptor.retirement !== null) throw invalid("tool_selection_retired", `Tool revision '${key}' is retired.`);
    const origins = snapshotOrigins(input.origins);
    if (origins.some((origin) => !registration.allowedOrigins.includes(origin))) throw invalid("tool_selection_origin_invalid", `Tool revision '${key}' is not admitted for every selected origin.`);
    return Object.freeze({ registration, origins });
  });
  tools.sort((left, right) => toolRevisionKey(left.registration.descriptor.ref).localeCompare(toolRevisionKey(right.registration.descriptor.ref)));
  const frozen = Object.freeze(tools);
  const selectionId = createToolContractIdentity("agent-anything.fixed-local-tool-selection.v2", {
    toolCatalogId: registrations.toolCatalog.catalogId,
    operationCatalogId: operationCatalog.id,
    operationCatalogRevision: operationCatalog.revision,
    tools: frozen.map((selected) => ({
      tool: selected.registration.descriptor.ref,
      origins: selected.origins,
    })),
  });
  return Object.freeze({
    schemaVersion: 2 as const,
    selectionId,
    revision: selectionId,
    toolCatalogId: registrations.toolCatalog.catalogId,
    operationCatalogId: operationCatalog.id,
    operationCatalogRevision: operationCatalog.revision,
    tools: frozen,
  });
}

export function createControllerToolExposureProof(
  selection: ToolSelectionRevision,
  controllerRequestId: string,
): ToolExposureProof {
  const modelTools = selection.tools.filter((selected) => selected.origins.includes("model"));
  const exposedTools = Object.freeze(modelTools.map((selected) => selected.registration.descriptor.ref));
  const catalog = createToolCatalogSnapshot(modelTools.map((selected) => descriptorInput(selected.registration.descriptor)));
  const id = createToolContractIdentity("agent-anything.controller-tool-exposure.v1", {
    selectionRevision: selection.revision,
    controllerRequestId,
    exposedTools,
  });
  return Object.freeze({
    id,
    selectionRevision: selection.revision,
    consumer: "controller" as const,
    controllerRequestId: token(controllerRequestId),
    exposedTools,
    catalog,
  });
}

export function snapshotToolSelectionRevision(
  input: ToolSelectionRevision,
): ToolSelectionRevision {
  if (input === null || typeof input !== "object" || input.schemaVersion !== 2) {
    throw invalid("tool_selection_invalid", "Tool selection must use schema version 2.");
  }
  if (!Array.isArray(input.tools)) {
    throw invalid("tool_selection_invalid", "Tool selection entries must be an array.");
  }
  const keys = new Set<string>();
  const tools = input.tools.map((selected) => {
    if (selected === null || typeof selected !== "object") {
      throw invalid("tool_selection_invalid", "A selected Tool entry must be an object.");
    }
    const descriptor = createToolCatalogSnapshot([
      descriptorInput(selected.registration.descriptor),
    ]).tools[0]!;
    const key = toolRevisionKey(descriptor.ref);
    if (keys.has(key)) {
      throw invalid("tool_selection_duplicate", `Tool revision '${key}' is selected more than once.`);
    }
    keys.add(key);
    const registration = selected.registration;
    if (
      registration.descriptor.fingerprint !== descriptor.fingerprint ||
      operationRevisionKey(registration.operation.operation.ref) !==
        operationRevisionKey(descriptor.operationBinding.operation) ||
      registration.operation.binding.ref.revision !== descriptor.operationBinding.revision
    ) {
      throw invalid("tool_selection_invalid", `Tool revision '${key}' has an incoherent registration.`);
    }
    const allowedOrigins = snapshotOrigins(registration.allowedOrigins);
    const registrationBase = Object.freeze({
      admissionId: token(registration.admissionId),
      descriptor,
      operation: registration.operation,
      allowedOrigins,
      admittedAt: token(registration.admittedAt),
    });
    if (
      registration.registrationFingerprint !==
      createToolContractIdentity("agent-anything.tool-registration.v2", registrationBase)
    ) {
      throw invalid("tool_selection_invalid", `Tool revision '${key}' has an invalid registration fingerprint.`);
    }
    const origins = snapshotOrigins(selected.origins);
    if (origins.some((origin) => !allowedOrigins.includes(origin))) {
      throw invalid("tool_selection_origin_invalid", `Tool revision '${key}' is selected for an unadmitted origin.`);
    }
    return Object.freeze({
      registration: Object.freeze({ ...registrationBase, registrationFingerprint: registration.registrationFingerprint }),
      origins,
    });
  });
  tools.sort((left, right) => toolRevisionKey(left.registration.descriptor.ref).localeCompare(toolRevisionKey(right.registration.descriptor.ref)));
  const frozen = Object.freeze(tools);
  const expectedId = createToolContractIdentity("agent-anything.fixed-local-tool-selection.v2", {
    toolCatalogId: token(input.toolCatalogId),
    operationCatalogId: token(input.operationCatalogId),
    operationCatalogRevision: token(input.operationCatalogRevision),
    tools: frozen.map((selected) => ({
      tool: selected.registration.descriptor.ref,
      origins: selected.origins,
    })),
  });
  if (
    token(input.selectionId) !== expectedId ||
    token(input.revision) !== expectedId
  ) {
    throw invalid("tool_selection_invalid", "Tool selection identity does not match its immutable contents.");
  }
  return Object.freeze({
    schemaVersion: 2,
    selectionId: expectedId,
    revision: expectedId,
    toolCatalogId: input.toolCatalogId,
    operationCatalogId: input.operationCatalogId,
    operationCatalogRevision: input.operationCatalogRevision,
    tools: frozen,
  });
}

export function findSelectedTool(
  selection: ToolSelectionRevision,
  refOrName: ToolRevisionRef | string,
  origin: ToolRequestOrigin,
): SelectedTool | undefined {
  return selection.tools.find((selected) => {
    const matches = typeof refOrName === "string"
      ? selected.registration.descriptor.name === refOrName
      : toolRevisionKey(selected.registration.descriptor.ref) === toolRevisionKey(refOrName);
    return matches && selected.origins.includes(origin);
  });
}

function descriptorInput(descriptor: ToolDescriptor) {
  const { fingerprint: _fingerprint, ...input } = descriptor;
  return input;
}

function snapshotOrigins(input: readonly ToolRequestOrigin[]): readonly ToolRequestOrigin[] {
  if (!Array.isArray(input) || input.length === 0 || input.some((origin) => origin !== "model" && origin !== "workflow")) throw invalid("tool_selection_origin_invalid", "Selection requires model, workflow, or both origins.");
  return Object.freeze([...new Set(input)].sort());
}

function token(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) throw invalid("tool_selection_invalid", "A canonical token is required.");
  return input;
}

function invalid(code: string, message: string): ToolSelectionValidationError {
  return new ToolSelectionValidationError(code, message);
}
