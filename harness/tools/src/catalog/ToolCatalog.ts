import type {
  ToolBindingRef,
  ToolRevisionRef,
  ToolSchemaRevisionRefs,
  ToolSourceRef,
} from "../identity/index.js";
import { createToolContractIdentity, toolRevisionKey } from "../identity/index.js";
import { admitToolInputSchema, ToolInputSchemaAdmissionError } from "../validation/index.js";

export type ToolJsonValue = null | boolean | number | string |
  readonly ToolJsonValue[] | ToolJsonObject;

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
  readonly ref: ToolRevisionRef;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ToolJsonObject;
  readonly outputSchema?: ToolJsonObject;
  readonly schemaRevisions: ToolSchemaRevisionRefs;
  readonly annotations: ToolAnnotations;
  readonly source: ToolSourceRef;
  readonly binding: ToolBindingRef;
  readonly retirement: ToolRetirement | null;
  readonly metadata: ToolJsonObject;
  readonly fingerprint: string;
}

export interface ToolRetirement {
  readonly retiredAt: string;
  readonly reasonCode: string;
}

export type ToolDescriptorInput = Omit<ToolDescriptor, "fingerprint" | "annotations" | "metadata" | "retirement"> & {
  readonly annotations?: ToolAnnotations;
  readonly metadata?: ToolJsonObject;
  readonly retirement?: ToolRetirement | null;
};

export interface ToolCatalogSnapshot {
  readonly schemaVersion: 3;
  readonly catalogId: string;
  readonly revision: string;
  readonly tools: readonly ToolDescriptor[];
}

export type ToolCatalogValidationCode =
  | "tool_descriptor_invalid"
  | "tool_identity_invalid"
  | "tool_revision_duplicate"
  | "tool_name_duplicate"
  | "tool_binding_invalid"
  | "tool_schema_revision_invalid"
  | "tool_schema_dialect_unsupported"
  | "tool_input_schema_invalid"
  | "tool_input_schema_unbuildable"
  | "tool_data_not_serializable";

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

export function createToolCatalogSnapshot(
  inputs: readonly ToolDescriptorInput[],
): ToolCatalogSnapshot {
  if (!Array.isArray(inputs)) fail("tool_descriptor_invalid", "Tool catalog input must be an array.", "tools");
  assertDenseArray(inputs, "tools");
  const names = new Set<string>();
  const revisions = new Set<string>();
  const tools = inputs.map((input, index) => {
    const descriptor = snapshotDescriptor(input, index);
    try {
      admitToolInputSchema(descriptor);
    } catch (error) {
      if (error instanceof ToolInputSchemaAdmissionError) {
        fail(error.code, error.message, `tools[${index}].inputSchema`);
      }
      throw error;
    }
    return descriptor;
  });
  for (const tool of tools) {
    const revisionKey = toolRevisionKey(tool.ref);
    if (revisions.has(revisionKey)) fail("tool_revision_duplicate", `Tool revision '${revisionKey}' is duplicated.`, "tools");
    if (names.has(tool.name)) fail("tool_name_duplicate", `Tool name '${tool.name}' is duplicated in one catalog.`, "tools");
    revisions.add(revisionKey);
    names.add(tool.name);
  }
  tools.sort((left, right) => toolRevisionKey(left.ref).localeCompare(toolRevisionKey(right.ref)));
  const frozen = Object.freeze(tools);
  const catalogId = createToolContractIdentity("agent-anything.tool-catalog.v3", frozen);
  return Object.freeze({
    schemaVersion: 3 as const,
    catalogId,
    revision: catalogId,
    tools: frozen,
  });
}

export function findToolDescriptor(
  catalog: ToolCatalogSnapshot,
  name: string,
  revision?: string,
): ToolDescriptor | undefined {
  return catalog.tools.find((tool) =>
    tool.name === name && (revision === undefined || tool.ref.revision === revision)
  );
}

function snapshotDescriptor(input: ToolDescriptorInput, index: number): ToolDescriptor {
  const path = `tools[${index}]`;
  assertExactRecord(input, path, [
    "ref", "name", "description", "inputSchema", "outputSchema",
    "schemaRevisions", "annotations", "source", "binding",
    "retirement", "metadata",
  ]);
  const rawRef = assertExactRecord(input.ref, `${path}.ref`, ["tool", "revision"]);
  const rawTool = assertExactRecord(rawRef.tool, `${path}.ref.tool`, ["namespace", "name"]);
  const ref: ToolRevisionRef = Object.freeze({
    tool: Object.freeze({
      namespace: token(rawTool.namespace, `${path}.ref.tool.namespace`),
      name: token(rawTool.name, `${path}.ref.tool.name`),
    }),
    revision: token(rawRef.revision, `${path}.ref.revision`),
  });
  const name = token(input.name, `${path}.name`);
  const rawSchemas = assertExactRecord(input.schemaRevisions, `${path}.schemaRevisions`, ["dialect", "input", "output", "translation"]);
  const schemas: ToolSchemaRevisionRefs = Object.freeze({
    dialect: token(rawSchemas.dialect, `${path}.schemaRevisions.dialect`),
    input: token(rawSchemas.input, `${path}.schemaRevisions.input`),
    output: rawSchemas.output === null ? null : token(rawSchemas.output, `${path}.schemaRevisions.output`),
    translation: token(rawSchemas.translation, `${path}.schemaRevisions.translation`),
  });
  const rawSource = assertExactRecord(input.source, `${path}.source`, ["kind", "sourceId", "sourceRevision", "activationEpoch"]);
  if (!["harness", "product", "mcp", "plugin", "remote"].includes(String(rawSource.kind))) {
    fail("tool_identity_invalid", "Unsupported Tool source kind.", `${path}.source.kind`);
  }
  if (rawSource.activationEpoch !== null && (!Number.isSafeInteger(rawSource.activationEpoch) || Number(rawSource.activationEpoch) < 1)) {
    fail("tool_identity_invalid", "Tool activation epoch must be a positive integer or null.", `${path}.source.activationEpoch`);
  }
  const source: ToolSourceRef = Object.freeze({
    kind: rawSource.kind as ToolSourceRef["kind"],
    sourceId: token(rawSource.sourceId, `${path}.source.sourceId`),
    sourceRevision: rawSource.sourceRevision === null ? null : token(rawSource.sourceRevision, `${path}.source.sourceRevision`),
    activationEpoch: rawSource.activationEpoch as number | null,
  });
  const binding = snapshotBinding(input.binding, `${path}.binding`);
  const annotations = snapshotAnnotations(input.annotations ?? {}, `${path}.annotations`);
  const base = {
    ref,
    name,
    ...(input.description === undefined ? {} : { description: text(input.description, `${path}.description`) }),
    inputSchema: snapshotJsonObject(input.inputSchema, `${path}.inputSchema`),
    ...(input.outputSchema === undefined ? {} : { outputSchema: snapshotJsonObject(input.outputSchema, `${path}.outputSchema`) }),
    schemaRevisions: schemas,
    annotations,
    source,
    binding,
    retirement: input.retirement == null
      ? null
      : snapshotRetirement(input.retirement, `${path}.retirement`),
    metadata: snapshotJsonObject(input.metadata ?? {}, `${path}.metadata`),
  };
  return Object.freeze({
    ...base,
    fingerprint: createToolContractIdentity("agent-anything.tool-revision.v3", base),
  });
}

function snapshotBinding(input: ToolBindingRef, path: string): ToolBindingRef {
  const raw = assertRecord(input, path);
  switch (raw.kind) {
    case "operation": {
      assertExactRecord(input, path, ["kind", "operation", "revision"]);
      const operationRevision = assertExactRecord(raw.operation, `${path}.operation`, ["operation", "revision"]);
      const operation = assertExactRecord(operationRevision.operation, `${path}.operation.operation`, ["namespace", "name"]);
      return Object.freeze({
        kind: "operation" as const,
        operation: Object.freeze({
          operation: Object.freeze({
            namespace: token(operation.namespace, `${path}.operation.operation.namespace`),
            name: token(operation.name, `${path}.operation.operation.name`),
          }),
          revision: token(operationRevision.revision, `${path}.operation.revision`),
        }),
        revision: token(raw.revision, `${path}.revision`),
      });
    }
    case "interaction": {
      assertExactRecord(input, path, ["kind", "protocol", "blockingScope", "revision"]);
      const protocol = assertExactRecord(raw.protocol, `${path}.protocol`, ["owner", "kind", "revision"]);
      if (!["none", "branch", "run"].includes(String(raw.blockingScope))) {
        fail("tool_binding_invalid", "Tool Interaction binding has an invalid blocking scope.", `${path}.blockingScope`);
      }
      return Object.freeze({
        kind: "interaction" as const,
        protocol: Object.freeze({
          owner: token(protocol.owner, `${path}.protocol.owner`),
          kind: token(protocol.kind, `${path}.protocol.kind`),
          revision: token(protocol.revision, `${path}.protocol.revision`),
        }),
        blockingScope: raw.blockingScope as "none" | "branch" | "run",
        revision: token(raw.revision, `${path}.revision`),
      });
    }
    case "descendant_agent":
    case "descendant_message": {
      assertExactRecord(input, path, ["kind", "agent", "revision"]);
      const agent = assertExactRecord(raw.agent, `${path}.agent`, ["id", "revision"]);
      return Object.freeze({
        kind: raw.kind,
        agent: Object.freeze({
          id: token(agent.id, `${path}.agent.id`),
          revision: token(agent.revision, `${path}.agent.revision`),
        }),
        revision: token(raw.revision, `${path}.revision`),
      });
    }
    default:
      return fail("tool_binding_invalid", "Tool binding kind is unsupported.", `${path}.kind`);
  }
}

function snapshotJsonObject(input: unknown, path: string): ToolJsonObject {
  return snapshotJson(input, path, new WeakSet()) as ToolJsonObject;
}

function snapshotJson(input: unknown, path: string, ancestors: WeakSet<object>): ToolJsonValue {
  if (input === null || typeof input === "boolean" || typeof input === "string") return input;
  if (typeof input === "number" && Number.isFinite(input)) return Object.is(input, -0) ? 0 : input;
  if (typeof input !== "object") fail("tool_data_not_serializable", "Tool data must be JSON serializable.", path);
  if (ancestors.has(input)) fail("tool_data_not_serializable", "Tool data cannot contain cycles.", path);
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      assertDenseArray(input, path, "tool_data_not_serializable");
      return Object.freeze(input.map((value, index) => snapshotJson(value, `${path}[${index}]`, ancestors)));
    }
    const record = assertJsonRecord(input, path);
    assertNoAccessors(record, path);
    if (Reflect.ownKeys(record).length !== Object.keys(record).length) {
      fail("tool_data_not_serializable", "Tool data cannot contain symbol properties.", path);
    }
    const output: Record<string, ToolJsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("tool_data_not_serializable", "Tool data contains a forbidden key.", `${path}.${key}`);
      output[key] = snapshotJson(record[key], `${path}.${key}`, ancestors);
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(input);
  }
}

function assertRecord(input: unknown, path: string): Record<string, any> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("tool_descriptor_invalid", "A plain object is required.", path);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail("tool_descriptor_invalid", "A plain object is required.", path);
  return input as Record<string, any>;
}

function assertJsonRecord(input: unknown, path: string): Record<string, any> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("tool_data_not_serializable", "Tool data must use plain objects.", path);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("tool_data_not_serializable", "Tool data must use plain objects.", path);
  }
  return input as Record<string, any>;
}

function assertExactRecord(input: unknown, path: string, allowed: readonly string[]): Record<string, any> {
  const record = assertRecord(input, path);
  assertNoAccessors(record, path);
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string") || keys.some((key) => !allowed.includes(key as string))) {
    fail("tool_descriptor_invalid", "Tool descriptor contains an unsupported field.", path);
  }
  return record;
}

function assertNoAccessors(input: Record<string, any>, path: string): void {
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      fail("tool_data_not_serializable", "Tool data cannot contain accessors.", `${path}.${String(key)}`);
    }
  }
}

function assertDenseArray(
  input: readonly unknown[],
  path: string,
  code: ToolCatalogValidationCode = "tool_descriptor_invalid",
): void {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      fail(code, "Tool data cannot contain sparse arrays.", `${path}[${index}]`);
    }
  }
}

function snapshotAnnotations(input: ToolAnnotations, path: string): ToolAnnotations {
  const record = assertExactRecord(input, path, [
    "title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint",
  ]);
  const result: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "title") result[key] = text(value, `${path}.${key}`);
    else if (typeof value === "boolean") result[key] = value;
    else fail("tool_descriptor_invalid", "Tool annotation has an invalid value.", `${path}.${key}`);
  }
  return Object.freeze(result);
}

function snapshotRetirement(input: ToolRetirement, path: string): ToolRetirement {
  const record = assertExactRecord(input, path, ["retiredAt", "reasonCode"]);
  return Object.freeze({
    retiredAt: dateTime(record.retiredAt, `${path}.retiredAt`),
    reasonCode: token(record.reasonCode, `${path}.reasonCode`),
  });
}

function token(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || input.length > 1024) fail("tool_identity_invalid", "A canonical token is required.", path);
  return input;
}

function text(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0 || input !== input.trim() || input.length > 8192) fail("tool_descriptor_invalid", "Bounded non-empty text is required.", path);
  return input;
}

function dateTime(input: unknown, path: string): string {
  if (typeof input !== "string" || Number.isNaN(Date.parse(input)) || new Date(input).toISOString() !== input) fail("tool_descriptor_invalid", "An ISO timestamp is required.", path);
  return input;
}

function fail(code: ToolCatalogValidationCode, message: string, path: string): never {
  throw new ToolCatalogValidationError(code, message, path);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
