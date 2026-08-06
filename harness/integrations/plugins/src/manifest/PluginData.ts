import { createHash } from "node:crypto";

export type PluginJsonPrimitive = null | boolean | number | string;
export type PluginJsonValue =
  | PluginJsonPrimitive
  | readonly PluginJsonValue[]
  | PluginJsonObject;

export interface PluginJsonObject {
  readonly [key: string]: PluginJsonValue;
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_ARRAY_LENGTH = 512;
const MAX_JSON_OBJECT_KEYS = 512;
const MAX_JSON_KEY_LENGTH = 256;
const MAX_JSON_STRING_LENGTH = 65_536;

export function snapshotPluginJsonObject(
  input: unknown,
  path: string,
): PluginJsonObject {
  const snapshot = snapshotPluginJsonValue(
    input,
    path,
    0,
    { nodes: 0 },
    new WeakSet<object>(),
  );
  if (!isPluginJsonObject(snapshot)) {
    throw new TypeError(`${path} must be a JSON object.`);
  }
  return snapshot;
}

export function createPluginContractFingerprint(
  domain: string,
  input: unknown,
): string {
  const canonicalDomain = validatePluginToken(domain, "fingerprint.domain", 256);
  const snapshot = snapshotPluginJsonValue(
    input,
    "fingerprint",
    0,
    { nodes: 0 },
    new WeakSet<object>(),
  );
  return `sha256:${createHash("sha256")
    .update(canonicalDomain, "utf8")
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
    if (
      typeof key !== "string" ||
      (!required.has(key) && !optional.has(key))
    ) {
      throw new TypeError(`${path} contains an unsupported field.`);
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
        throw new TypeError(
          `${path}[${key}] must be an enumerable data property.`,
        );
      }
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw new TypeError(`${path} cannot be sparse.`);
    }
  }
}

export function validatePluginToken(
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

export function validatePluginText(
  input: unknown,
  path: string,
  maxLength: number,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maxLength ||
    input !== input.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)
  ) {
    throw new TypeError(`${path} must be bounded non-empty text.`);
  }
  return input;
}

export function validateSha256Fingerprint(
  input: unknown,
  path: string,
): string {
  if (
    typeof input !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(input)
  ) {
    throw new TypeError(`${path} must be a canonical SHA-256 fingerprint.`);
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
    input < 1
  ) {
    throw new TypeError(`${path} must be a positive safe integer.`);
  }
  return input;
}

export function validatePluginDateTime(
  input: unknown,
  path: string,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 64 ||
    input !== input.trim()
  ) {
    throw new TypeError(`${path} must be a canonical ISO date-time.`);
  }
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    throw new TypeError(`${path} must be a canonical ISO date-time.`);
  }
  return input;
}

export function snapshotPluginTokenSet(
  input: unknown,
  path: string,
  maxLength = 256,
): readonly string[] {
  assertCanonicalDataArray(input, path);
  if (input.length > maxLength) {
    throw new TypeError(`${path} exceeds the item limit.`);
  }
  const values = input.map((value, index) =>
    validatePluginToken(value, `${path}[${index}]`)
  );
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new TypeError(`${path} cannot contain duplicate values.`);
  }
  return Object.freeze([...values].sort(compareStrings));
}

function snapshotPluginJsonValue(
  input: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
  active: WeakSet<object>,
): PluginJsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError(`${path} exceeds Plugin JSON complexity limits.`);
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
        throw new TypeError(`${path} exceeds the Plugin JSON array limit.`);
      }
      return Object.freeze(input.map((value, index) =>
        snapshotPluginJsonValue(
          value,
          `${path}[${index}]`,
          depth + 1,
          budget,
          active,
        )
      ));
    }

    assertPlainRecord(input, path);
    const keys = Object.keys(input).sort(compareStrings);
    if (
      keys.length > MAX_JSON_OBJECT_KEYS ||
      Reflect.ownKeys(input).length !== keys.length
    ) {
      throw new TypeError(`${path} exceeds the Plugin JSON object limit.`);
    }
    const snapshot: Record<string, PluginJsonValue> = {};
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
        throw new TypeError(
          `${path}.${key} must be an enumerable data property.`,
        );
      }
      snapshot[key] = snapshotPluginJsonValue(
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

function canonicalJson(value: PluginJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as PluginJsonObject;
  const keys = Object.keys(object).sort(compareStrings);
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`
  ).join(",")}}`;
}

function isPluginJsonObject(
  value: PluginJsonValue,
): value is PluginJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
