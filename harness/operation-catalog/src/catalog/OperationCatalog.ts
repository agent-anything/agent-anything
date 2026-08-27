import type { OperationBindingKind } from "../binding/OperationBinding.js";
import {
  operationRevisionKey,
  snapshotOperationBindingRevisionRef,
  snapshotOperationRevisionRef,
  type OperationBindingRevisionRef,
  type OperationRevisionRef,
} from "../identity/index.js";
import { dateTime, denseArray, fail, strictRecord, token, uniqueSorted } from "../contract/OperationContractValidation.js";

export type OperationRequestOrigin =
  | "automatic_stage"
  | "controller_protocol"
  | "tool_request"
  | "trusted_workflow"
  | "product_request"
  | "host_request";

export interface OperationRoles {
  readonly requestOrigins: readonly OperationRequestOrigin[];
  readonly exposure: "eager_tool" | "deferred_tool" | "workflow_only" | "non_tool";
  readonly runControl: OperationBindingKind;
  readonly trust: "effect_free" | "canonical_external_effect" | "remote_hosted_trust_edge";
  readonly participation:
    | "semantic_owner"
    | "action_adapter"
    | "composite_coordinator"
    | "descendant_adapter"
    | "executor_operation";
  readonly domainPurpose: string;
}

export interface OperationRevision {
  readonly ref: OperationRevisionRef;
  readonly semanticOwner: string;
  readonly requestSchemaRevision: string;
  readonly resultSchemaRevision: string;
  readonly roles: OperationRoles;
}

export interface OperationBindingRevision {
  readonly ref: OperationBindingRevisionRef;
  readonly kind: OperationBindingKind;
  readonly resolverId: string;
  readonly resolverRevision: string;
}

export interface OperationRetirement {
  readonly retiredAt: string;
  readonly reasonCode: string;
}

export interface RegisteredOperation {
  readonly admissionId: string;
  readonly operation: OperationRevision;
  readonly binding: OperationBindingRevision;
  readonly sourceRevision: string;
  readonly allowedRequestOrigins: readonly OperationRequestOrigin[];
  readonly admittedAt: string;
  readonly retirement: OperationRetirement | null;
}

export interface OperationCatalogSnapshot {
  readonly id: string;
  readonly revision: string;
  readonly entries: readonly RegisteredOperation[];
}

export function createOperationCatalogSnapshot(input: OperationCatalogSnapshot): OperationCatalogSnapshot {
  strictRecord(input, "OperationCatalogSnapshot", ["id", "revision", "entries"], "operation_catalog_invalid");
  denseArray(input.entries, "OperationCatalogSnapshot.entries");
  const entries = uniqueSorted(
    input.entries.map((entry, index) => snapshotRegistration(entry, index)),
    (entry) => operationRevisionKey(entry.operation.ref),
    "OperationCatalogSnapshot.entries",
  );
  return Object.freeze({
    id: token(input.id, "OperationCatalogSnapshot.id"),
    revision: token(input.revision, "OperationCatalogSnapshot.revision"),
    entries,
  });
}

export function findRegisteredOperation(
  snapshot: OperationCatalogSnapshot,
  ref: OperationRevisionRef,
): RegisteredOperation | undefined {
  const key = operationRevisionKey(ref);
  return snapshot.entries.find((entry) => operationRevisionKey(entry.operation.ref) === key);
}

function snapshotRegistration(input: RegisteredOperation, index: number): RegisteredOperation {
  const path = `OperationCatalogSnapshot.entries[${index}]`;
  strictRecord(input, path, ["admissionId", "operation", "binding", "sourceRevision", "allowedRequestOrigins", "admittedAt", "retirement"]);
  const operation = snapshotRevision(input.operation, `${path}.operation`);
  const binding = snapshotBinding(input.binding, `${path}.binding`);
  if (operationRevisionKey(operation.ref) !== operationRevisionKey(binding.ref.operation)) {
    fail("operation_binding_invalid", "Binding Operation revision does not match registration.", `${path}.binding.ref.operation`);
  }
  denseArray(input.allowedRequestOrigins, `${path}.allowedRequestOrigins`);
  const origins = uniqueSorted(
    input.allowedRequestOrigins.map((origin, originIndex) => requestOrigin(origin, `${path}.allowedRequestOrigins[${originIndex}]`)),
    (origin) => origin,
    `${path}.allowedRequestOrigins`,
  );
  if (origins.length === 0) fail("operation_contract_invalid", "At least one request origin is required.", `${path}.allowedRequestOrigins`);
  return Object.freeze({
    admissionId: token(input.admissionId, `${path}.admissionId`),
    operation,
    binding,
    sourceRevision: token(input.sourceRevision, `${path}.sourceRevision`),
    allowedRequestOrigins: origins,
    admittedAt: dateTime(input.admittedAt, `${path}.admittedAt`),
    retirement: input.retirement === null ? null : snapshotRetirement(input.retirement, `${path}.retirement`),
  });
}

function snapshotRevision(input: OperationRevision, path: string): OperationRevision {
  strictRecord(input, path, ["ref", "semanticOwner", "requestSchemaRevision", "resultSchemaRevision", "roles"]);
  return Object.freeze({
    ref: snapshotOperationRevisionRef(input.ref),
    semanticOwner: token(input.semanticOwner, `${path}.semanticOwner`),
    requestSchemaRevision: token(input.requestSchemaRevision, `${path}.requestSchemaRevision`),
    resultSchemaRevision: token(input.resultSchemaRevision, `${path}.resultSchemaRevision`),
    roles: snapshotRoles(input.roles, `${path}.roles`),
  });
}

function snapshotBinding(input: OperationBindingRevision, path: string): OperationBindingRevision {
  strictRecord(input, path, ["ref", "kind", "resolverId", "resolverRevision"], "operation_binding_invalid");
  return Object.freeze({
    ref: snapshotOperationBindingRevisionRef(input.ref),
    kind: bindingKind(input.kind, `${path}.kind`),
    resolverId: token(input.resolverId, `${path}.resolverId`),
    resolverRevision: token(input.resolverRevision, `${path}.resolverRevision`),
  });
}

function snapshotRoles(input: OperationRoles, path: string): OperationRoles {
  strictRecord(input, path, ["requestOrigins", "exposure", "runControl", "trust", "participation", "domainPurpose"]);
  denseArray(input.requestOrigins, `${path}.requestOrigins`);
  const requestOrigins = uniqueSorted(
    input.requestOrigins.map((origin, index) => requestOrigin(origin, `${path}.requestOrigins[${index}]`)),
    (origin) => origin,
    `${path}.requestOrigins`,
  );
  if (!["eager_tool", "deferred_tool", "workflow_only", "non_tool"].includes(input.exposure)) fail("operation_contract_invalid", "Unsupported exposure role.", `${path}.exposure`);
  if (!["effect_free", "canonical_external_effect", "remote_hosted_trust_edge"].includes(input.trust)) fail("operation_contract_invalid", "Unsupported trust role.", `${path}.trust`);
  if (!["semantic_owner", "action_adapter", "composite_coordinator", "descendant_adapter", "executor_operation"].includes(input.participation)) fail("operation_contract_invalid", "Unsupported participation role.", `${path}.participation`);
  return Object.freeze({
    requestOrigins,
    exposure: input.exposure,
    runControl: bindingKind(input.runControl, `${path}.runControl`),
    trust: input.trust,
    participation: input.participation,
    domainPurpose: token(input.domainPurpose, `${path}.domainPurpose`),
  });
}

function snapshotRetirement(input: OperationRetirement, path: string): OperationRetirement {
  strictRecord(input, path, ["retiredAt", "reasonCode"]);
  return Object.freeze({ retiredAt: dateTime(input.retiredAt, `${path}.retiredAt`), reasonCode: token(input.reasonCode, `${path}.reasonCode`) });
}

function requestOrigin(input: unknown, path: string): OperationRequestOrigin {
  if (!["automatic_stage", "controller_protocol", "tool_request", "trusted_workflow", "product_request", "host_request"].includes(input as string)) fail("operation_contract_invalid", "Unsupported request origin.", path);
  return input as OperationRequestOrigin;
}

function bindingKind(input: unknown, path: string): OperationBindingKind {
  if (!["internal", "direct", "hosted", "composite", "descendant_agent"].includes(input as string)) fail("operation_binding_invalid", "Unsupported binding kind.", path);
  return input as OperationBindingKind;
}
