import {
  createToolCatalogSnapshot,
  type ToolCatalogSnapshot,
} from "../catalog/ToolCatalog.js";
import { createToolContractIdentity } from "../identity/ToolIdentity.js";
import type {
  RegisteredTool,
  ToolRegistrationSnapshot,
} from "../registration/ToolRegistration.js";

export type ToolRequestOrigin = "model" | "workflow";

export interface ToolSelectionInput {
  readonly toolName: string;
  readonly origins: readonly ToolRequestOrigin[];
}

export interface SelectedTool {
  readonly registration: RegisteredTool;
  readonly origins: readonly [ToolRequestOrigin, ...ToolRequestOrigin[]];
}

export interface ToolSelectionSnapshot {
  readonly schemaVersion: 1;
  readonly selectionId: string;
  readonly registrationSnapshotId: string;
  readonly tools: readonly SelectedTool[];
  readonly modelCatalog: ToolCatalogSnapshot;
}

export type ToolSelectionValidationCode =
  | "tool_selection_invalid"
  | "tool_selection_duplicate"
  | "tool_selection_unknown"
  | "tool_selection_origin_invalid";

export class ToolSelectionValidationError extends TypeError {
  constructor(
    readonly code: ToolSelectionValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ToolSelectionValidationError";
  }
}

export function createToolSelectionSnapshot(
  registrations: ToolRegistrationSnapshot,
  inputs: readonly ToolSelectionInput[],
): ToolSelectionSnapshot {
  assertRegistrationSnapshot(registrations);
  assertCanonicalArray(inputs);

  const byName = new Map(
    registrations.registrations.map((registration) => [
      registration.descriptor.name,
      registration,
    ]),
  );
  const selectedNames = new Set<string>();
  const tools = inputs.map((input, index) => {
    const path = `selection[${index}]`;
    assertSelectionInput(input, path);
    if (selectedNames.has(input.toolName)) {
      throw selectionError(
        "tool_selection_duplicate",
        `Tool is selected more than once: ${input.toolName}.`,
        `${path}.toolName`,
      );
    }
    selectedNames.add(input.toolName);
    const registration = byName.get(input.toolName);
    if (registration === undefined) {
      throw selectionError(
        "tool_selection_unknown",
        `Selected Tool is not registered: ${input.toolName}.`,
        `${path}.toolName`,
      );
    }
    const origins = snapshotOrigins(input.origins, `${path}.origins`);
    return Object.freeze({ registration, origins });
  });
  tools.sort((left, right) => compareStrings(
    left.registration.descriptor.name,
    right.registration.descriptor.name,
  ));
  const frozenTools = Object.freeze(tools);
  const selectionIdentityFields = Object.freeze({
    registrationSnapshotId: registrations.snapshotId,
    tools: frozenTools.map((tool) => Object.freeze({
      registrationFingerprint: tool.registration.registrationFingerprint,
      origins: tool.origins,
    })),
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    selectionId: createToolContractIdentity(
      "agent-anything.tool-selection.v1",
      selectionIdentityFields,
    ),
    registrationSnapshotId: registrations.snapshotId,
    tools: frozenTools,
    modelCatalog: createToolCatalogSnapshot(
      frozenTools
        .filter((tool) => tool.origins.includes("model"))
        .map((tool) => tool.registration.descriptor),
    ),
  });
}

export function findSelectedTool(
  snapshot: ToolSelectionSnapshot,
  toolName: string,
  origin: ToolRequestOrigin,
): SelectedTool | undefined {
  return snapshot.tools.find((tool) =>
    tool.registration.descriptor.name === toolName &&
    tool.origins.includes(origin)
  );
}

function assertRegistrationSnapshot(
  input: ToolRegistrationSnapshot,
): void {
  if (
    input === null ||
    typeof input !== "object" ||
    input.schemaVersion !== 1 ||
    typeof input.snapshotId !== "string" ||
    !Array.isArray(input.registrations) ||
    !Object.isFrozen(input) ||
    !Object.isFrozen(input.registrations)
  ) {
    throw selectionError(
      "tool_selection_invalid",
      "Tool selection requires an immutable ToolRegistrationSnapshot.",
      "registrations",
    );
  }
}

function assertCanonicalArray(input: unknown): asserts input is readonly unknown[] {
  if (!Array.isArray(input)) {
    throw selectionError(
      "tool_selection_invalid",
      "Tool selection input must be an array.",
      "selection",
    );
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw selectionError(
        "tool_selection_invalid",
        "Tool selection input contains an unsupported property.",
        `selection.${String(key)}`,
      );
    }
    if (key !== "length") assertDataProperty(input, key, `selection[${key}]`);
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw selectionError(
        "tool_selection_invalid",
        "Tool selection input cannot be sparse.",
        `selection[${index}]`,
      );
    }
  }
}

function assertSelectionInput(
  input: unknown,
  path: string,
): asserts input is ToolSelectionInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw selectionError(
      "tool_selection_invalid",
      `Tool selection entry must be a plain object at ${path}.`,
      path,
    );
  }
  const candidate = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== 2 ||
    !keys.includes("toolName") ||
    !keys.includes("origins")
  ) {
    throw selectionError(
      "tool_selection_invalid",
      `Tool selection entry has unsupported fields at ${path}.`,
      path,
    );
  }
  assertDataProperty(candidate, "toolName", `${path}.toolName`);
  assertDataProperty(candidate, "origins", `${path}.origins`);
  if (
    typeof candidate.toolName !== "string" ||
    candidate.toolName.length === 0 ||
    candidate.toolName !== candidate.toolName.trim()
  ) {
    throw selectionError(
      "tool_selection_invalid",
      "Selected Tool name must be non-empty canonical text.",
      `${path}.toolName`,
    );
  }
}

function snapshotOrigins(
  input: readonly ToolRequestOrigin[],
  path: string,
): readonly [ToolRequestOrigin, ...ToolRequestOrigin[]] {
  if (!Array.isArray(input) || input.length === 0) {
    throw selectionError(
      "tool_selection_origin_invalid",
      "A selected Tool requires at least one request origin.",
      path,
    );
  }
  const origins = input.map((origin, index) => {
    if (origin !== "model" && origin !== "workflow") {
      throw selectionError(
        "tool_selection_origin_invalid",
        "Tool request origin must be model or workflow.",
        `${path}[${index}]`,
      );
    }
    return origin;
  }).sort(compareOrigins);
  if (new Set(origins).size !== origins.length) {
    throw selectionError(
      "tool_selection_origin_invalid",
      "Tool request origins cannot contain duplicates.",
      path,
    );
  }
  return Object.freeze(origins) as readonly [
    ToolRequestOrigin,
    ...ToolRequestOrigin[],
  ];
}

function assertDataProperty(
  input: object,
  key: PropertyKey,
  path: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    throw selectionError(
      "tool_selection_invalid",
      `Tool selection requires an enumerable data property at ${path}.`,
      path,
    );
  }
}

function compareOrigins(
  left: ToolRequestOrigin,
  right: ToolRequestOrigin,
): number {
  const order: Record<ToolRequestOrigin, number> = { model: 0, workflow: 1 };
  return order[left] - order[right];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionError(
  code: ToolSelectionValidationCode,
  message: string,
  path: string,
): ToolSelectionValidationError {
  return new ToolSelectionValidationError(code, message, path);
}
