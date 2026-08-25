import { createHash } from "node:crypto";
import type { ContextJsonValue } from "@agent-anything/context/contract";

export function createDelegationContractIdentity(
  domain: string,
  value: unknown,
): string {
  token(domain, "Delegation identity domain");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(domain)) {
    throw new TypeError("Delegation identity domain must be canonical.");
  }
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

export function snapshotDelegationJsonValue(
  value: ContextJsonValue,
  field: string,
): ContextJsonValue {
  try {
    return deepFreeze(JSON.parse(canonicalJson(value)) as ContextJsonValue);
  } catch (error) {
    throw new TypeError(`${field} must contain finite plain JSON data.`, {
      cause: error,
    });
  }
}

export function strictRecord<T>(
  input: T,
  field: string,
  keys: readonly string[],
): asserts input is T & Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${field} must be an object.`);
  }
  const unsupported = Object.keys(input).find((key) => !keys.includes(key));
  if (unsupported !== undefined) {
    throw new TypeError(`${field} contains unsupported field '${unsupported}'.`);
  }
}

export function token(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input !== input.trim() ||
    /\s/.test(input)
  ) {
    throw new TypeError(`${field} must be a canonical token.`);
  }
  return input;
}

export function boundedText(
  input: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximumLength
  ) {
    throw new TypeError(`${field} must be bounded non-empty text.`);
  }
  return input;
}

export function isoDateTime(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    Number.isNaN(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  ) {
    throw new TypeError(`${field} must be an ISO date-time.`);
  }
  return input;
}

export function positiveInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return input as number;
}

export function nonNegativeInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return input as number;
}

export function snapshotTokenList(
  input: readonly string[],
  field: string,
  maximumItems = 256,
): readonly string[] {
  if (!Array.isArray(input) || input.length > maximumItems) {
    throw new TypeError(`${field} must be a bounded array.`);
  }
  const values = input.map((value, index) => token(value, `${field}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${field} must not contain duplicates.`);
  }
  values.sort(compareStrings);
  return Object.freeze(values);
}

export function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) {
      deepFreeze(value);
    }
    Object.freeze(input);
  }
  return input;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Delegation identity data must contain finite numbers.");
    }
    return Object.is(value, -0) ? "0" : value.toString();
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") {
    throw new TypeError("Delegation identity data must be serializable.");
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Delegation identity data must use plain objects.");
  }
  const keys = Object.keys(value).sort(compareStrings);
  if (Reflect.ownKeys(value).length !== keys.length) {
    throw new TypeError("Delegation identity data cannot contain symbol properties.");
  }
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
