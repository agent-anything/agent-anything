import type { ISODateTimeString, Metadata } from "./primitives/index.js";

export function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object.`);
  }
}

export function assertMetadata(
  value: unknown,
  field: string,
): asserts value is Metadata {
  assertRecord(value, field);
}

export function assertNonEmpty(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

export function assertDateTime(
  value: unknown,
  field: string,
): asserts value is ISODateTimeString {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid date-time string.`);
  }
}

export function snapshotMetadata(metadata: Metadata): Metadata {
  return Object.freeze({ ...metadata });
}
