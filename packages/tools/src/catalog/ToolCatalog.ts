export type ToolJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ToolJsonValue[]
  | ToolJsonObject;

export interface ToolJsonObject {
  readonly [key: string]: ToolJsonValue;
}

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ToolJsonObject;
  readonly outputSchema?: ToolJsonObject;
  readonly annotations: ToolAnnotations;
  readonly metadata: ToolJsonObject;
}

export interface ToolDescriptorInput {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ToolJsonObject;
  readonly outputSchema?: ToolJsonObject;
  readonly annotations?: ToolAnnotations;
  readonly metadata?: ToolJsonObject;
}

export interface ToolCatalogSnapshot {
  readonly schemaVersion: 1;
  readonly tools: readonly ToolDescriptor[];
}

export type ToolCatalogValidationCode =
  | "tool_descriptor_invalid"
  | "tool_name_invalid"
  | "tool_name_duplicate"
  | "tool_description_invalid"
  | "tool_annotation_invalid"
  | "tool_data_not_serializable"
  | "tool_data_too_deep"
  | "tool_data_too_large";

export class ToolCatalogValidationError extends TypeError {
  constructor(
    readonly code: ToolCatalogValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ToolCatalogValidationError";
  }
}

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function createToolCatalogSnapshot(
  inputs: readonly ToolDescriptorInput[],
): ToolCatalogSnapshot {
  assertCanonicalInputArray(inputs);

  const names = new Set<string>();
  const tools = inputs.map((input, index) => {
    const path = `tools[${index}]`;
    assertToolDescriptorInput(input, path);
    const name = validateToken(input.name, `${path}.name`, "Tool name");
    if (names.has(name)) {
      throw validationError(
        "tool_name_duplicate",
        `Tool name is already registered: ${name}`,
        `${path}.name`,
      );
    }
    names.add(name);

    const description = validateOptionalText(
      input.description,
      `${path}.description`,
    );
    const annotations = snapshotAnnotations(input.annotations, `${path}.annotations`);
    const state: SnapshotState = { nodes: 0, ancestors: new Set<object>() };
    const inputSchema = snapshotObject(
      input.inputSchema,
      `${path}.inputSchema`,
      0,
      state,
    );
    const outputSchema = input.outputSchema === undefined
      ? undefined
      : snapshotObject(input.outputSchema, `${path}.outputSchema`, 0, state);
    const metadata = snapshotObject(input.metadata ?? {}, `${path}.metadata`, 0, state);

    return Object.freeze({
      name,
      ...(description === undefined ? {} : { description }),
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      annotations,
      metadata,
    });
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    tools: Object.freeze(tools),
  });
}

function assertCanonicalInputArray(
  inputs: readonly ToolDescriptorInput[],
): void {
  if (!Array.isArray(inputs)) {
    throw validationError(
      "tool_descriptor_invalid",
      "Tool catalog input must be an array.",
      "tools",
    );
  }
  for (const key of Reflect.ownKeys(inputs)) {
    if (typeof key !== "string") {
      throw validationError(
        "tool_descriptor_invalid",
        "Tool catalog input has a symbol property.",
        "tools",
      );
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= inputs.length) {
      throw validationError(
        "tool_descriptor_invalid",
        `Tool catalog input has an unsupported property at tools.${key}.`,
        `tools.${key}`,
      );
    }
    assertDataProperty(inputs, key, `tools[${key}]`);
  }
  for (let index = 0; index < inputs.length; index += 1) {
    if (!Object.hasOwn(inputs, index)) {
      throw validationError(
        "tool_descriptor_invalid",
        `Tool catalog input is sparse at tools[${index}].`,
        `tools[${index}]`,
      );
    }
  }
}

function assertToolDescriptorInput(
  input: unknown,
  path: string,
): asserts input is ToolDescriptorInput {
  assertPlainRecord(input, path);
  const allowedKeys = new Set([
    "name",
    "description",
    "inputSchema",
    "outputSchema",
    "annotations",
    "metadata",
  ]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw validationError(
        "tool_descriptor_invalid",
        `Unsupported Tool descriptor field at ${path}.${String(key)}.`,
        `${path}.${String(key)}`,
      );
    }
    assertDataProperty(input, key, `${path}.${key}`);
  }
}

export function findToolDescriptor(
  catalog: ToolCatalogSnapshot,
  name: string,
): ToolDescriptor | undefined {
  return catalog.tools.find((tool) => tool.name === name);
}

function snapshotAnnotations(
  input: ToolAnnotations | undefined,
  path: string,
): ToolAnnotations {
  if (input === undefined) {
    return Object.freeze({});
  }
  assertPlainRecord(input, path);

  const allowedKeys = new Set([
    "title",
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw validationError(
        "tool_annotation_invalid",
        `Unsupported Tool annotation at ${path}.${String(key)}.`,
        `${path}.${String(key)}`,
      );
    }
    assertDataProperty(input, key, `${path}.${key}`);
  }

  const title = validateOptionalText(input.title, `${path}.title`);
  const readOnlyHint = validateOptionalBoolean(input.readOnlyHint, `${path}.readOnlyHint`);
  const destructiveHint = validateOptionalBoolean(
    input.destructiveHint,
    `${path}.destructiveHint`,
  );
  const idempotentHint = validateOptionalBoolean(
    input.idempotentHint,
    `${path}.idempotentHint`,
  );
  const openWorldHint = validateOptionalBoolean(
    input.openWorldHint,
    `${path}.openWorldHint`,
  );

  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
    ...(destructiveHint === undefined
      ? {}
      : { destructiveHint }),
    ...(idempotentHint === undefined
      ? {}
      : { idempotentHint }),
    ...(openWorldHint === undefined
      ? {}
      : { openWorldHint }),
  });
}

interface SnapshotState {
  nodes: number;
  ancestors: Set<object>;
}

function snapshotObject(
  input: unknown,
  path: string,
  depth: number,
  state: SnapshotState,
): ToolJsonObject {
  assertPlainRecord(input, path);
  return snapshotValue(input, path, depth, state) as ToolJsonObject;
}

function snapshotValue(
  input: unknown,
  path: string,
  depth: number,
  state: SnapshotState,
): ToolJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw validationError(
      "tool_data_too_large",
      `Tool catalog data exceeds ${MAX_NODES} values.`,
      path,
    );
  }
  if (depth > MAX_DEPTH) {
    throw validationError(
      "tool_data_too_deep",
      `Tool catalog data exceeds depth ${MAX_DEPTH}.`,
      path,
    );
  }

  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string"
  ) {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw validationError(
        "tool_data_not_serializable",
        `Tool catalog number must be finite at ${path}.`,
        path,
      );
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object") {
    throw validationError(
      "tool_data_not_serializable",
      `Tool catalog value is not serializable at ${path}.`,
      path,
    );
  }
  if (state.ancestors.has(input)) {
    throw validationError(
      "tool_data_not_serializable",
      `Tool catalog data contains a cycle at ${path}.`,
      path,
    );
  }

  state.ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string") {
          throw validationError(
            "tool_data_not_serializable",
            `Tool catalog array has a symbol property at ${path}.`,
            path,
          );
        }
        if (key === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
          throw validationError(
            "tool_data_not_serializable",
            `Tool catalog array has an unsupported property at ${path}.${key}.`,
            `${path}.${key}`,
          );
        }
      }
      const values: ToolJsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) {
          throw validationError(
            "tool_data_not_serializable",
            `Tool catalog array is sparse at ${path}[${index}].`,
            `${path}[${index}]`,
          );
        }
        assertDataProperty(input, String(index), `${path}[${index}]`);
        values.push(snapshotValue(input[index], `${path}[${index}]`, depth + 1, state));
      }
      return Object.freeze(values);
    }

    assertPlainRecord(input, path);
    const output: Record<string, ToolJsonValue> = {};
    const keys = Object.keys(input).sort(compareStrings);
    if (Reflect.ownKeys(input).length !== keys.length) {
      throw validationError(
        "tool_data_not_serializable",
        `Tool catalog object has non-string properties at ${path}.`,
        path,
      );
    }
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) {
        throw validationError(
          "tool_data_not_serializable",
          `Tool catalog object uses a forbidden key at ${childPath}.`,
          childPath,
        );
      }
      assertDataProperty(input, key, childPath);
      output[key] = snapshotValue(
        (input as Record<string, unknown>)[key],
        childPath,
        depth + 1,
        state,
      );
    }
    return Object.freeze(output);
  } finally {
    state.ancestors.delete(input);
  }
}

function assertPlainRecord(input: unknown, path: string): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw validationError(
      "tool_data_not_serializable",
      `Tool catalog object is required at ${path}.`,
      path,
    );
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(
      "tool_data_not_serializable",
      `Tool catalog value must be a plain object at ${path}.`,
      path,
    );
  }
}

function assertDataProperty(input: object, key: PropertyKey, path: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    throw validationError(
      "tool_data_not_serializable",
      `Tool catalog value must use enumerable data properties at ${path}.`,
      path,
    );
  }
}

function validateToken(input: unknown, path: string, label: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 256 ||
    input !== input.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(input)
  ) {
    throw validationError(
      "tool_name_invalid",
      `${label} must be a canonical non-empty token.`,
      path,
    );
  }
  return input;
}

function validateOptionalText(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 8_192 ||
    input !== input.trim()
  ) {
    throw validationError(
      path.endsWith("description")
        ? "tool_description_invalid"
        : "tool_annotation_invalid",
      `Tool text must be non-empty, trimmed, and at most 8192 characters at ${path}.`,
      path,
    );
  }
  return input;
}

function validateOptionalBoolean(input: unknown, path: string): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") {
    throw validationError(
      "tool_annotation_invalid",
      `Tool annotation must be boolean at ${path}.`,
      path,
    );
  }
  return input;
}

function validationError(
  code: ToolCatalogValidationCode,
  message: string,
  path: string,
): ToolCatalogValidationError {
  return new ToolCatalogValidationError(code, message, path);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
