import type { ActionExecutorDescriptor } from "./ActionRegistration.js";

export type SerializableValue =
  | null
  | boolean
  | number
  | string
  | readonly SerializableValue[]
  | SerializableObject;

export interface SerializableObject {
  readonly [key: string]: SerializableValue;
}

export interface PreparedActionInvocation {
  readonly contractVersion: string;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly payload: SerializableValue;
  readonly secretReferences: readonly string[];
}

export interface PreparedActionInvocationInput {
  readonly contractVersion: string;
  readonly executorId: string;
  readonly executorVersion: string;
  readonly payload: SerializableValue;
  readonly secretReferences?: readonly string[];
}

export type PreparedActionInvocationValidationCode =
  | "invocation_contract_version_invalid"
  | "invocation_executor_invalid"
  | "invocation_secret_reference_invalid"
  | "invocation_secret_reference_duplicate"
  | "invocation_not_serializable"
  | "invocation_too_deep"
  | "invocation_too_large"
  | "invocation_executor_mismatch";

export class PreparedActionInvocationValidationError extends TypeError {
  constructor(
    readonly code: PreparedActionInvocationValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PreparedActionInvocationValidationError";
  }
}

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function createPreparedActionInvocation(
  input: PreparedActionInvocationInput,
): PreparedActionInvocation {
  assertInvocationInput(input);
  const contractVersion = validateToken(
    input.contractVersion,
    "contractVersion",
    "invocation_contract_version_invalid",
    "Invocation contract version",
  );
  const executorId = validateToken(
    input.executorId,
    "executorId",
    "invocation_executor_invalid",
    "Invocation executor id",
  );
  const executorVersion = validateToken(
    input.executorVersion,
    "executorVersion",
    "invocation_executor_invalid",
    "Invocation executor version",
  );
  const payload = snapshotSerializableValue(input.payload, "payload", 0, {
    nodes: 0,
    ancestors: new Set<object>(),
  });
  const secretReferences = snapshotSecretReferences(input.secretReferences ?? []);

  return Object.freeze({
    contractVersion,
    executorId,
    executorVersion,
    payload,
    secretReferences,
  });
}

export function assertPreparedInvocationMatchesExecutor(
  invocation: PreparedActionInvocation,
  executor: ActionExecutorDescriptor,
): void {
  if (
    invocation.executorId !== executor.id ||
    invocation.executorVersion !== executor.version ||
    invocation.contractVersion !== executor.invocationContractVersion
  ) {
    throw invocationError(
      "invocation_executor_mismatch",
      "Prepared invocation does not match the registered executor identity and contract version.",
      "executor",
    );
  }
}

interface SnapshotState {
  nodes: number;
  ancestors: Set<object>;
}

function snapshotSerializableValue(
  input: unknown,
  path: string,
  depth: number,
  state: SnapshotState,
): SerializableValue {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw invocationError(
      "invocation_too_large",
      `Prepared invocation exceeds ${MAX_NODES} values.`,
      path,
    );
  }
  if (depth > MAX_DEPTH) {
    throw invocationError(
      "invocation_too_deep",
      `Prepared invocation exceeds depth ${MAX_DEPTH}.`,
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
      throw invocationError(
        "invocation_not_serializable",
        `Prepared invocation number must be finite at ${path}.`,
        path,
      );
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object") {
    throw invocationError(
      "invocation_not_serializable",
      `Prepared invocation contains a non-serializable value at ${path}.`,
      path,
    );
  }
  if (state.ancestors.has(input)) {
    throw invocationError(
      "invocation_not_serializable",
      `Prepared invocation contains a cycle at ${path}.`,
      path,
    );
  }

  state.ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      assertCanonicalArray(input, path);
      return Object.freeze(input.map((value, index) => snapshotSerializableValue(
        value,
        `${path}[${index}]`,
        depth + 1,
        state,
      )));
    }

    assertPlainObject(input, path);
    const output: Record<string, SerializableValue> = {};
    const keys = Object.keys(input).sort(compareStrings);
    if (Reflect.ownKeys(input).length !== keys.length) {
      throw invocationError(
        "invocation_not_serializable",
        `Prepared invocation object has non-string properties at ${path}.`,
        path,
      );
    }
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) {
        throw invocationError(
          "invocation_not_serializable",
          `Prepared invocation uses a forbidden key at ${childPath}.`,
          childPath,
        );
      }
      assertDataProperty(input, key, childPath);
      output[key] = snapshotSerializableValue(
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

function snapshotSecretReferences(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input)) {
    throw invocationError(
      "invocation_secret_reference_invalid",
      "Secret references must be an array.",
      "secretReferences",
    );
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw invocationError(
        "invocation_secret_reference_invalid",
        "Secret references have a symbol property.",
        "secretReferences",
      );
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
      throw invocationError(
        "invocation_secret_reference_invalid",
        `Secret references have an unsupported property at secretReferences.${key}.`,
        `secretReferences.${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw invocationError(
        "invocation_secret_reference_invalid",
        `Secret references must use enumerable data properties at secretReferences[${key}].`,
        `secretReferences[${key}]`,
      );
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw invocationError(
        "invocation_secret_reference_invalid",
        `Secret references are sparse at secretReferences[${index}].`,
        `secretReferences[${index}]`,
      );
    }
  }
  const seen = new Set<string>();
  const references = input.map((reference, index) => {
    const value = validateToken(
      reference,
      `secretReferences[${index}]`,
      "invocation_secret_reference_invalid",
      "Secret reference",
    );
    if (seen.has(value)) {
      throw invocationError(
        "invocation_secret_reference_duplicate",
        `Secret reference is duplicated: ${value}`,
        `secretReferences[${index}]`,
      );
    }
    seen.add(value);
    return value;
  });
  references.sort(compareStrings);
  return Object.freeze(references);
}

function assertInvocationInput(
  input: unknown,
): asserts input is PreparedActionInvocationInput {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw invocationError(
      "invocation_not_serializable",
      "Prepared invocation input must be a plain object.",
      "invocation",
    );
  }
  const allowedKeys = new Set([
    "contractVersion",
    "executorId",
    "executorVersion",
    "payload",
    "secretReferences",
  ]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw invocationError(
        "invocation_not_serializable",
        `Unsupported prepared invocation field at invocation.${String(key)}.`,
        `invocation.${String(key)}`,
      );
    }
    assertDataProperty(input, key, `invocation.${key}`);
  }
}

function assertCanonicalArray(input: readonly unknown[], path: string): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw invocationError(
        "invocation_not_serializable",
        `Prepared invocation array has a symbol property at ${path}.`,
        path,
      );
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
      throw invocationError(
        "invocation_not_serializable",
        `Prepared invocation array has an unsupported property at ${path}.${key}.`,
        `${path}.${key}`,
      );
    }
    assertDataProperty(input, key, `${path}[${key}]`);
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw invocationError(
        "invocation_not_serializable",
        `Prepared invocation array is sparse at ${path}[${index}].`,
        `${path}[${index}]`,
      );
    }
  }
}

function assertPlainObject(input: object, path: string): void {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invocationError(
      "invocation_not_serializable",
      `Prepared invocation value must be a plain object at ${path}.`,
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
    throw invocationError(
      "invocation_not_serializable",
      `Prepared invocation must use enumerable data properties at ${path}.`,
      path,
    );
  }
}

function validateToken(
  input: unknown,
  path: string,
  code: PreparedActionInvocationValidationCode,
  label: string,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1_024 ||
    input !== input.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input)
  ) {
    throw invocationError(code, `${label} must be a canonical non-empty token.`, path);
  }
  return input;
}

function invocationError(
  code: PreparedActionInvocationValidationCode,
  message: string,
  path: string,
): PreparedActionInvocationValidationError {
  return new PreparedActionInvocationValidationError(code, message, path);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
