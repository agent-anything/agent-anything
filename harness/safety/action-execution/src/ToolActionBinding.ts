import { createHash } from "node:crypto";
import {
  createToolRegistrationSnapshot,
  createToolSelectionSnapshot,
  type ToolCatalogSnapshot,
  type ToolRequestOrigin,
  type ToolSelectionSnapshot,
  type ToolSourceRef,
} from "@agent-anything/tools";
import {
  createActionRegistrationSnapshot,
  findActionRegistration,
  type ActionRegistrationSnapshot,
} from "./ActionRegistration.js";

export interface ToolActionBinding {
  readonly toolName: string;
  readonly toolRegistrationFingerprint: string;
  readonly descriptorFingerprint: string;
  readonly source: ToolSourceRef;
  readonly origins: readonly [ToolRequestOrigin, ...ToolRequestOrigin[]];
  readonly boundActionName: string;
  readonly actionRegistrationFingerprint: string;
}

export interface ToolActionBindingSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly toolRegistrationSnapshotId: string;
  readonly toolSelectionId: string;
  readonly toolCatalog: ToolCatalogSnapshot;
  readonly actionRegistrationSnapshotId: string;
  readonly bindings: readonly ToolActionBinding[];
}

export type ToolActionBindingValidationCode =
  | "tool_action_binding_invalid"
  | "tool_action_binding_missing"
  | "tool_action_binding_contradictory";

export class ToolActionBindingValidationError extends TypeError {
  constructor(
    readonly code: ToolActionBindingValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ToolActionBindingValidationError";
  }
}

export function createToolActionBindingSnapshot(
  selection: ToolSelectionSnapshot,
  actions: ActionRegistrationSnapshot,
): ToolActionBindingSnapshot {
  assertSelectionSnapshot(selection);
  assertActionSnapshot(actions);

  const bindings = selection.tools.map((selected, index) => {
    const registration = findActionRegistration(
      actions,
      selected.registration.boundActionName,
    );
    if (registration === undefined) {
      throw bindingError(
        "tool_action_binding_missing",
        `Selected Tool '${selected.registration.descriptor.name}' has no Action registration '${selected.registration.boundActionName}'.`,
        `bindings[${index}].boundActionName`,
      );
    }
    return Object.freeze({
      toolName: selected.registration.descriptor.name,
      toolRegistrationFingerprint:
        selected.registration.registrationFingerprint,
      descriptorFingerprint: selected.registration.descriptorFingerprint,
      source: selected.registration.source,
      origins: selected.origins,
      boundActionName: registration.actionName,
      actionRegistrationFingerprint: registration.registrationFingerprint,
    });
  });
  const frozenBindings = Object.freeze(bindings);
  const snapshotId = createBindingSnapshotIdentity({
    toolRegistrationSnapshotId: selection.registrationSnapshotId,
    toolSelectionId: selection.selectionId,
    toolCatalogId: selection.modelCatalog.catalogId,
    actionRegistrationSnapshotId: actions.snapshotId,
    bindings: frozenBindings,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId,
    toolRegistrationSnapshotId: selection.registrationSnapshotId,
    toolSelectionId: selection.selectionId,
    toolCatalog: selection.modelCatalog,
    actionRegistrationSnapshotId: actions.snapshotId,
    bindings: frozenBindings,
  });
}

export function createEmptyToolActionBindingSnapshot(): ToolActionBindingSnapshot {
  const registrations = createToolRegistrationSnapshot([]);
  const selection = createToolSelectionSnapshot(registrations, []);
  return createToolActionBindingSnapshot(
    selection,
    createActionRegistrationSnapshot([]),
  );
}

export function findToolActionBinding(
  snapshot: ToolActionBindingSnapshot,
  toolName: string,
  origin: ToolRequestOrigin,
): ToolActionBinding | undefined {
  return snapshot.bindings.find((binding) =>
    binding.toolName === toolName && binding.origins.includes(origin)
  );
}

export function assertToolActionBindingSnapshot(
  input: ToolActionBindingSnapshot,
): void {
  if (
    input === null ||
    typeof input !== "object" ||
    input.schemaVersion !== 1 ||
    !isCanonicalIdentity(input.snapshotId) ||
    !isCanonicalIdentity(input.toolRegistrationSnapshotId) ||
    !isCanonicalIdentity(input.toolSelectionId) ||
    !isCanonicalIdentity(input.actionRegistrationSnapshotId) ||
    !Array.isArray(input.bindings) ||
    !Object.isFrozen(input) ||
    !isDeeplyFrozen(input)
  ) {
    throw bindingError(
      "tool_action_binding_invalid",
      "A factory-created immutable ToolActionBindingSnapshot is required.",
      "toolBindings",
    );
  }

  const expected = createBindingSnapshotIdentity({
    toolRegistrationSnapshotId: input.toolRegistrationSnapshotId,
    toolSelectionId: input.toolSelectionId,
    toolCatalogId: input.toolCatalog.catalogId,
    actionRegistrationSnapshotId: input.actionRegistrationSnapshotId,
    bindings: input.bindings,
  });
  if (input.snapshotId !== expected) {
    throw bindingError(
      "tool_action_binding_contradictory",
      "Tool Action binding snapshot identity does not match its contents.",
      "toolBindings.snapshotId",
    );
  }
}

function assertSelectionSnapshot(input: ToolSelectionSnapshot): void {
  if (
    input === null ||
    typeof input !== "object" ||
    input.schemaVersion !== 1 ||
    !isCanonicalIdentity(input.selectionId) ||
    !isCanonicalIdentity(input.registrationSnapshotId) ||
    !Array.isArray(input.tools) ||
    !Object.isFrozen(input) ||
    !isDeeplyFrozen(input)
  ) {
    throw bindingError(
      "tool_action_binding_invalid",
      "Tool Action binding requires an immutable ToolSelectionSnapshot.",
      "selection",
    );
  }
}

function assertActionSnapshot(input: ActionRegistrationSnapshot): void {
  if (
    input === null ||
    typeof input !== "object" ||
    input.schemaVersion !== 1 ||
    !isCanonicalIdentity(input.snapshotId) ||
    !Array.isArray(input.registrations) ||
    !Object.isFrozen(input) ||
    !isDeeplyFrozen(input)
  ) {
    throw bindingError(
      "tool_action_binding_invalid",
      "Tool Action binding requires an immutable ActionRegistrationSnapshot.",
      "actions",
    );
  }
}

function createBindingSnapshotIdentity(input: {
  readonly toolRegistrationSnapshotId: string;
  readonly toolSelectionId: string;
  readonly toolCatalogId: string;
  readonly actionRegistrationSnapshotId: string;
  readonly bindings: readonly ToolActionBinding[];
}): string {
  const values = [
    input.toolRegistrationSnapshotId,
    input.toolSelectionId,
    input.toolCatalogId,
    input.actionRegistrationSnapshotId,
    ...input.bindings.flatMap((binding) => [
      binding.toolName,
      binding.toolRegistrationFingerprint,
      binding.descriptorFingerprint,
      binding.source.kind,
      binding.source.sourceId,
      binding.source.sourceRevision ?? "",
      binding.source.activationEpoch === null
        ? ""
        : binding.source.activationEpoch.toString(),
      binding.source.capabilityId,
      binding.origins.join(","),
      binding.boundActionName,
      binding.actionRegistrationFingerprint,
    ]),
  ];
  const encoded = values.map(encodeToken).join("");
  return `sha256:${createHash("sha256")
    .update("agent-anything.tool-action-binding-snapshot.v1", "utf8")
    .update("\0", "utf8")
    .update(encoded, "utf8")
    .digest("hex")}`;
}

function encodeToken(value: string): string {
  return `${value.length}.${value}`;
}

function isCanonicalIdentity(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input === input.trim();
}

function isDeeplyFrozen(input: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof input !== "object" || input === null) return true;
  if (seen.has(input)) return true;
  seen.add(input);
  if (!Object.isFrozen(input)) return false;
  return Reflect.ownKeys(input).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor !== undefined &&
      descriptor.get === undefined &&
      descriptor.set === undefined &&
      isDeeplyFrozen(descriptor.value, seen);
  });
}

function bindingError(
  code: ToolActionBindingValidationCode,
  message: string,
  path: string,
): ToolActionBindingValidationError {
  return new ToolActionBindingValidationError(code, message, path);
}
