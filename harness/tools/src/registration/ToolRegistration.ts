import {
  createToolCatalogSnapshot,
  type ToolDescriptor,
  type ToolDescriptorInput,
} from "../catalog/ToolCatalog.js";
import { createToolContractIdentity } from "../identity/ToolIdentity.js";

export type ToolSourceKind =
  | "harness"
  | "product"
  | "mcp"
  | "plugin"
  | "remote";

export interface ToolSourceRef {
  readonly kind: ToolSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: string | null;
  readonly activationEpoch: number | null;
  readonly capabilityId: string;
}

export interface ToolSchemaIdentity {
  readonly dialect: string;
  readonly translationVersion: string;
}

export interface ToolRegistrationInput {
  readonly descriptor: ToolDescriptorInput;
  readonly source: ToolSourceRef;
  readonly schema: ToolSchemaIdentity;
  readonly boundActionName: string;
  readonly registrationVersion: string;
}

export interface RegisteredTool {
  readonly descriptor: ToolDescriptor;
  readonly source: ToolSourceRef;
  readonly schema: ToolSchemaIdentity;
  readonly descriptorFingerprint: string;
  readonly boundActionName: string;
  readonly registrationVersion: string;
  readonly registrationFingerprint: string;
}

export interface ToolRegistrationSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly registrations: readonly RegisteredTool[];
}

export type ToolRegistrationValidationCode =
  | "tool_registration_invalid"
  | "tool_source_invalid"
  | "tool_schema_identity_invalid"
  | "tool_bound_action_invalid"
  | "tool_registration_version_invalid";

export class ToolRegistrationValidationError extends TypeError {
  constructor(
    readonly code: ToolRegistrationValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ToolRegistrationValidationError";
  }
}

export function createToolRegistrationSnapshot(
  inputs: readonly ToolRegistrationInput[],
): ToolRegistrationSnapshot {
  assertCanonicalArray(inputs, "registrations");
  inputs.forEach((input, index) =>
    assertRegistrationInput(input, `registrations[${index}]`)
  );

  const descriptors = createToolCatalogSnapshot(
    inputs.map((input) => input.descriptor),
  ).tools;
  const inputByName = new Map(inputs.map((input) => [input.descriptor.name, input]));
  const registrations = descriptors.map((descriptor) => {
    const input = inputByName.get(descriptor.name);
    if (input === undefined) {
      throw registrationError(
        "tool_registration_invalid",
        `Tool registration input is missing for '${descriptor.name}'.`,
        "registrations",
      );
    }
    const source = snapshotSource(input.source, `registrations.${descriptor.name}.source`);
    const schema = snapshotSchema(input.schema, `registrations.${descriptor.name}.schema`);
    const boundActionName = validateToken(
      input.boundActionName,
      `registrations.${descriptor.name}.boundActionName`,
      "tool_bound_action_invalid",
      256,
    );
    const registrationVersion = validateToken(
      input.registrationVersion,
      `registrations.${descriptor.name}.registrationVersion`,
      "tool_registration_version_invalid",
      256,
    );
    const descriptorFingerprint = createToolContractIdentity(
      "agent-anything.tool-descriptor.v1",
      descriptor,
    );
    const registrationFields = {
      descriptorFingerprint,
      localToolName: descriptor.name,
      source,
      schema,
      boundActionName,
      registrationVersion,
    };
    return Object.freeze({
      descriptor,
      source,
      schema,
      descriptorFingerprint,
      boundActionName,
      registrationVersion,
      registrationFingerprint: createToolContractIdentity(
        "agent-anything.tool-registration.v1",
        registrationFields,
      ),
    });
  });
  const frozenRegistrations = Object.freeze(registrations);
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: createToolContractIdentity(
      "agent-anything.tool-registration-snapshot.v1",
      frozenRegistrations,
    ),
    registrations: frozenRegistrations,
  });
}

export function findToolRegistration(
  snapshot: ToolRegistrationSnapshot,
  localToolName: string,
): RegisteredTool | undefined {
  return snapshot.registrations.find(
    (registration) => registration.descriptor.name === localToolName,
  );
}

export function createToolSourceRef(input: ToolSourceRef): ToolSourceRef {
  return snapshotSource(input, "source");
}

function assertRegistrationInput(
  input: unknown,
  path: string,
): asserts input is ToolRegistrationInput {
  assertPlainRecord(input, path, "tool_registration_invalid");
  assertExactKeys(
    input,
    new Set([
      "descriptor",
      "source",
      "schema",
      "boundActionName",
      "registrationVersion",
    ]),
    path,
    "tool_registration_invalid",
  );
}

function snapshotSource(input: unknown, path: string): ToolSourceRef {
  assertPlainRecord(input, path, "tool_source_invalid");
  assertExactKeys(
    input,
    new Set([
      "kind",
      "sourceId",
      "sourceRevision",
      "activationEpoch",
      "capabilityId",
    ]),
    path,
    "tool_source_invalid",
  );
  if (
    input.kind !== "harness" &&
    input.kind !== "product" &&
    input.kind !== "mcp" &&
    input.kind !== "plugin" &&
    input.kind !== "remote"
  ) {
    throw registrationError(
      "tool_source_invalid",
      "Tool source kind is invalid.",
      `${path}.kind`,
    );
  }
  if (
    input.sourceRevision !== null &&
    (
      typeof input.sourceRevision !== "string" ||
      input.sourceRevision.length === 0 ||
      input.sourceRevision.length > 4_096 ||
      input.sourceRevision !== input.sourceRevision.trim()
    )
  ) {
    throw registrationError(
      "tool_source_invalid",
      "Tool source revision must be null or bounded non-empty text.",
      `${path}.sourceRevision`,
    );
  }
  const activationEpoch = input.activationEpoch;
  if (
    activationEpoch !== null &&
    (
      typeof activationEpoch !== "number" ||
      !Number.isSafeInteger(activationEpoch) ||
      activationEpoch < 1
    )
  ) {
    throw registrationError(
      "tool_source_invalid",
      "Tool source activation epoch must be null or a positive safe integer.",
      `${path}.activationEpoch`,
    );
  }
  return Object.freeze({
    kind: input.kind,
    sourceId: validateToken(
      input.sourceId,
      `${path}.sourceId`,
      "tool_source_invalid",
      256,
    ),
    sourceRevision: input.sourceRevision,
    activationEpoch,
    capabilityId: validateToken(
      input.capabilityId,
      `${path}.capabilityId`,
      "tool_source_invalid",
      256,
    ),
  });
}

function snapshotSchema(input: unknown, path: string): ToolSchemaIdentity {
  assertPlainRecord(input, path, "tool_schema_identity_invalid");
  assertExactKeys(
    input,
    new Set(["dialect", "translationVersion"]),
    path,
    "tool_schema_identity_invalid",
  );
  return Object.freeze({
    dialect: validateToken(
      input.dialect,
      `${path}.dialect`,
      "tool_schema_identity_invalid",
      256,
    ),
    translationVersion: validateToken(
      input.translationVersion,
      `${path}.translationVersion`,
      "tool_schema_identity_invalid",
      256,
    ),
  });
}

function assertCanonicalArray(input: unknown, path: string): asserts input is readonly unknown[] {
  if (!Array.isArray(input)) {
    throw registrationError(
      "tool_registration_invalid",
      "Tool registrations must be an array.",
      path,
    );
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw registrationError(
        "tool_registration_invalid",
        "Tool registrations contain an unsupported property.",
        `${path}.${String(key)}`,
      );
    }
    if (key !== "length") assertDataProperty(input, key, `${path}[${key}]`, "tool_registration_invalid");
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw registrationError(
        "tool_registration_invalid",
        "Tool registrations cannot be sparse.",
        `${path}[${index}]`,
      );
    }
  }
}

function assertPlainRecord(
  input: unknown,
  path: string,
  code: ToolRegistrationValidationCode,
): asserts input is Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw registrationError(code, `A plain object is required at ${path}.`, path);
  }
}

function assertExactKeys(
  input: object,
  allowed: ReadonlySet<string>,
  path: string,
  code: ToolRegistrationValidationCode,
): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw registrationError(
        code,
        `Unsupported Tool registration field at ${path}.${String(key)}.`,
        `${path}.${String(key)}`,
      );
    }
    assertDataProperty(input, key, `${path}.${key}`, code);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(input, key)) {
      throw registrationError(
        code,
        `Required Tool registration field is missing at ${path}.${key}.`,
        `${path}.${key}`,
      );
    }
  }
}

function assertDataProperty(
  input: object,
  key: PropertyKey,
  path: string,
  code: ToolRegistrationValidationCode,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    throw registrationError(
      code,
      `Tool registration requires an enumerable data property at ${path}.`,
      path,
    );
  }
}

function validateToken(
  input: unknown,
  path: string,
  code: ToolRegistrationValidationCode,
  maxLength: number,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maxLength ||
    input !== input.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input)
  ) {
    throw registrationError(
      code,
      `A canonical non-empty token is required at ${path}.`,
      path,
    );
  }
  return input;
}

function registrationError(
  code: ToolRegistrationValidationCode,
  message: string,
  path: string,
): ToolRegistrationValidationError {
  return new ToolRegistrationValidationError(code, message, path);
}
