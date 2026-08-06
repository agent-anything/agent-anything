import { createHash } from "node:crypto";

export type McpJsonPrimitive = null | boolean | number | string;
export type McpJsonValue =
  | McpJsonPrimitive
  | readonly McpJsonValue[]
  | McpJsonObject;
export interface McpJsonObject {
  readonly [key: string]: McpJsonValue;
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_ARRAY_LENGTH = 1_024;
const MAX_JSON_OBJECT_KEYS = 1_024;
const MAX_JSON_KEY_LENGTH = 256;
const MAX_JSON_STRING_LENGTH = 65_536;

export function snapshotMcpJsonObject(
  input: unknown,
  path: string,
): McpJsonObject {
  const budget = { nodes: 0 };
  const active = new WeakSet<object>();
  const snapshot = snapshotMcpJsonValue(input, path, 0, budget, active);
  if (!isMcpJsonObject(snapshot)) {
    throw new TypeError(`${path} must be a JSON object.`);
  }
  return snapshot;
}

export function createMcpContractFingerprint(
  domain: string,
  value: unknown,
): string {
  if (
    typeof domain !== "string" ||
    domain.length === 0 ||
    domain.length > 256 ||
    domain !== domain.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(domain)
  ) {
    throw new TypeError("MCP fingerprint requires a canonical versioned domain.");
  }

  const snapshot = snapshotMcpJsonValue(
    value,
    "fingerprint",
    0,
    { nodes: 0 },
    new WeakSet<object>(),
  );
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(snapshot), "utf8")
    .digest("hex")}`;
}

export function assertPlainRecord(
  input: unknown,
  path: string,
): asserts input is Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError(`${path} must be a plain object.`);
  }
}

export function assertExactDataProperties(
  input: object,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || (!required.has(key) && !optional.has(key))) {
      throw new TypeError(`${path} contains unsupported field '${String(key)}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${path}.${key} must be an enumerable data property.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      throw new TypeError(`${path}.${key} is required.`);
    }
  }
}

export function assertExtensibleDataProperties(
  input: object,
  required: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} contains a non-JSON property key.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${path}.${key} must be an enumerable data property.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      throw new TypeError(`${path}.${key} is required.`);
    }
  }
}

export function assertCanonicalDataArray(
  input: unknown,
  path: string,
): asserts input is readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${path} must be an array.`);
  }
  for (const key of Reflect.ownKeys(input)) {
    if (
      typeof key !== "string" ||
      (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
    ) {
      throw new TypeError(`${path} contains an unsupported array property.`);
    }
    if (key !== "length") {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        throw new TypeError(`${path}[${key}] must be an enumerable data property.`);
      }
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw new TypeError(`${path} cannot be sparse.`);
    }
  }
}

export function validateMcpToken(
  input: unknown,
  path: string,
  maxLength = 256,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maxLength ||
    input !== input.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(input)
  ) {
    throw new TypeError(`${path} must be a canonical non-empty token.`);
  }
  return input;
}

export function validateMcpText(
  input: unknown,
  path: string,
  maxLength: number,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maxLength ||
    input !== input.trim()
  ) {
    throw new TypeError(`${path} must be bounded non-empty text.`);
  }
  return input;
}

export function validatePositiveSafeInteger(
  input: unknown,
  path: string,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input <= 0
  ) {
    throw new TypeError(`${path} must be a positive safe integer.`);
  }
  return input;
}

export function validateNonNegativeSafeInteger(
  input: unknown,
  path: string,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0
  ) {
    throw new TypeError(`${path} must be a non-negative safe integer.`);
  }
  return input;
}

function snapshotMcpJsonValue(
  input: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
  active: WeakSet<object>,
): McpJsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError(`${path} exceeds MCP JSON complexity limits.`);
  }
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new TypeError(`${path} must contain finite JSON numbers.`);
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input === "string") {
    if (input.length > MAX_JSON_STRING_LENGTH) {
      throw new TypeError(`${path} contains an oversized JSON string.`);
    }
    return input;
  }
  if (typeof input !== "object") {
    throw new TypeError(`${path} must contain JSON values only.`);
  }
  if (active.has(input)) {
    throw new TypeError(`${path} cannot contain a cycle.`);
  }
  active.add(input);
  try {
    if (Array.isArray(input)) {
      assertCanonicalDataArray(input, path);
      if (input.length > MAX_JSON_ARRAY_LENGTH) {
        throw new TypeError(`${path} exceeds the MCP JSON array limit.`);
      }
      return Object.freeze(input.map((value, index) =>
        snapshotMcpJsonValue(value, `${path}[${index}]`, depth + 1, budget, active)
      ));
    }

    assertPlainRecord(input, path);
    const keys = Object.keys(input).sort(compareStrings);
    if (
      keys.length > MAX_JSON_OBJECT_KEYS ||
      Reflect.ownKeys(input).length !== keys.length
    ) {
      throw new TypeError(`${path} exceeds the MCP JSON object limit.`);
    }
    const snapshot: Record<string, McpJsonValue> = {};
    for (const key of keys) {
      if (key.length === 0 || key.length > MAX_JSON_KEY_LENGTH) {
        throw new TypeError(`${path} contains an invalid JSON key.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      snapshot[key] = snapshotMcpJsonValue(
        input[key],
        `${path}.${key}`,
        depth + 1,
        budget,
        active,
      );
    }
    return Object.freeze(snapshot);
  } finally {
    active.delete(input);
  }
}

function canonicalJson(value: McpJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as McpJsonObject;
  const keys = Object.keys(object).sort(compareStrings);
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`
  ).join(",")}}`;
}

export function isMcpJsonObject(value: McpJsonValue): value is McpJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
