import type { OperationCatalogSnapshot, RegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import { findRegisteredOperation } from "@agent-anything/operation-catalog/catalog";
import type { ToolCatalogSnapshot, ToolDescriptor, ToolDescriptorInput } from "../catalog/index.js";
import { createToolCatalogSnapshot } from "../catalog/index.js";
import { createToolContractIdentity, toolRevisionKey, type ToolRevisionRef } from "../identity/index.js";

export interface RegisteredTool {
  readonly admissionId: string;
  readonly descriptor: ToolDescriptor;
  readonly operation: RegisteredOperation;
  readonly allowedOrigins: readonly ("model" | "workflow")[];
  readonly admittedAt: string;
  readonly registrationFingerprint: string;
}

export interface ToolRegistrationInput {
  readonly admissionId: string;
  readonly descriptor: ToolDescriptorInput;
  readonly allowedOrigins: readonly ("model" | "workflow")[];
  readonly admittedAt: string;
}

export interface ToolRegistrationSnapshot {
  readonly schemaVersion: 2;
  readonly snapshotId: string;
  readonly toolCatalog: ToolCatalogSnapshot;
  readonly operationCatalogId: string;
  readonly operationCatalogRevision: string;
  readonly registrations: readonly RegisteredTool[];
}

export class ToolRegistrationValidationError extends TypeError {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolRegistrationValidationError";
  }
}

export function createToolRegistrationSnapshot(
  operationCatalog: OperationCatalogSnapshot,
  inputs: readonly ToolRegistrationInput[],
): ToolRegistrationSnapshot {
  const catalog = createToolCatalogSnapshot(inputs.map((input) => input.descriptor));
  const byRevision = new Map(inputs.map((input) => [toolRevisionKey(input.descriptor.ref), input]));
  const registrations = catalog.tools.map((descriptor) => {
    const input = byRevision.get(toolRevisionKey(descriptor.ref));
    if (input === undefined) throw invalid("tool_registration_invalid", "Tool registration input is missing.");
    const operation = findRegisteredOperation(operationCatalog, descriptor.operationBinding.operation);
    if (operation === undefined || operation.binding.ref.revision !== descriptor.operationBinding.revision) {
      throw invalid("tool_operation_binding_missing", `Tool '${descriptor.name}' does not bind an admitted Operation revision.`);
    }
    if (operation.retirement !== null && descriptor.retirement === null) {
      throw invalid("tool_operation_retired", `Tool '${descriptor.name}' cannot bind a retired Operation for new admission.`);
    }
    const allowedOrigins = snapshotOrigins(input.allowedOrigins);
    for (const origin of allowedOrigins) {
      const operationOrigin = origin === "model" ? "tool_request" : "trusted_workflow";
      if (!operation.allowedRequestOrigins.includes(operationOrigin)) {
        throw invalid("tool_origin_incompatible", `Tool '${descriptor.name}' origin is incompatible with its Operation.`);
      }
    }
    const base = Object.freeze({
      admissionId: token(input.admissionId, "admissionId"),
      descriptor,
      operation,
      allowedOrigins,
      admittedAt: dateTime(input.admittedAt, "admittedAt"),
    });
    return Object.freeze({
      ...base,
      registrationFingerprint: createToolContractIdentity("agent-anything.tool-registration.v2", base),
    });
  });
  const frozen = Object.freeze(registrations);
  return Object.freeze({
    schemaVersion: 2 as const,
    snapshotId: createToolContractIdentity("agent-anything.tool-registration-snapshot.v2", {
      operationCatalogId: operationCatalog.id,
      operationCatalogRevision: operationCatalog.revision,
      registrations: frozen.map((registration) => registration.registrationFingerprint),
    }),
    toolCatalog: catalog,
    operationCatalogId: operationCatalog.id,
    operationCatalogRevision: operationCatalog.revision,
    registrations: frozen,
  });
}

export function findToolRegistration(
  snapshot: ToolRegistrationSnapshot,
  refOrName: ToolRevisionRef | string,
): RegisteredTool | undefined {
  return snapshot.registrations.find((registration) => typeof refOrName === "string"
    ? registration.descriptor.name === refOrName
    : toolRevisionKey(registration.descriptor.ref) === toolRevisionKey(refOrName));
}

function snapshotOrigins(input: readonly ("model" | "workflow")[]): readonly ("model" | "workflow")[] {
  if (!Array.isArray(input) || input.length === 0 || input.some((value) => value !== "model" && value !== "workflow")) {
    throw invalid("tool_origin_invalid", "Tool admission requires model, workflow, or both origins.");
  }
  return Object.freeze([...new Set(input)].sort());
}

function token(input: unknown, field: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim()) throw invalid("tool_registration_invalid", `${field} must be a non-empty token.`);
  return input;
}

function dateTime(input: unknown, field: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) throw invalid("tool_registration_invalid", `${field} must be an ISO timestamp.`);
  return input;
}

function invalid(code: string, message: string): ToolRegistrationValidationError {
  return new ToolRegistrationValidationError(code, message);
}
