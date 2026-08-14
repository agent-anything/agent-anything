import {
  ContextContractError,
  type ContextContractFailureCode,
  type ContextJsonObject,
  type ContextJsonValue,
} from "./ContextContract.js";

// Shared strict snapshot helpers for the Context Contract families.

export function fail(
  code: ContextContractFailureCode,
  message: string,
  path: string,
): never {
  throw new ContextContractError(Object.freeze({ code, message, path }));
}

export function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
  code: ContextContractFailureCode = "context_contract_invalid",
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, `${path} must be an object.`, path);
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(code, `${path} contains unsupported field '${key}'.`, `${path}.${key}`);
    }
  }
}

export function token(
  value: unknown,
  path: string,
  code: ContextContractFailureCode = "context_contract_invalid",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(code, `${path} must be a non-empty string.`, path);
  }
  return value;
}

export function nullableToken(
  value: unknown,
  path: string,
  code: ContextContractFailureCode = "context_contract_invalid",
): string | null {
  return value === null ? null : token(value, path, code);
}

export function isoDateTime(
  value: unknown,
  path: string,
  code: ContextContractFailureCode = "context_contract_invalid",
): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail(code, `${path} must be an ISO date-time string.`, path);
  }
  return value;
}

export function nullableIsoDateTime(
  value: unknown,
  path: string,
  code: ContextContractFailureCode = "context_contract_invalid",
): string | null {
  return value === null ? null : isoDateTime(value, path, code);
}

export function nonNegativeInteger(
  value: unknown,
  path: string,
  code: ContextContractFailureCode = "context_contract_invalid",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(code, `${path} must be a non-negative safe integer.`, path);
  }
  return value as number;
}

export function positiveInteger(
  value: unknown,
  path: string,
  code: ContextContractFailureCode = "context_contract_invalid",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(code, `${path} must be a positive safe integer.`, path);
  }
  return value as number;
}

export function snapshotTokenList(
  value: unknown,
  path: string,
  options: { readonly allowEmpty?: boolean } = {},
  code: ContextContractFailureCode = "context_contract_invalid",
): readonly string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    fail(code, `${path} must be a non-empty array.`, path);
  }
  const values = value.map((item, index) =>
    token(item, `${path}[${index}]`, code),
  );
  if (new Set(values).size !== values.length) {
    fail(code, `${path} must not contain duplicate values.`, path);
  }
  return Object.freeze(values);
}

export function snapshotJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object> = new WeakSet<object>(),
  code: ContextContractFailureCode = "context_contract_invalid",
): ContextJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(code, `${path} must contain only finite numbers.`, path);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail(code, `${path} must be JSON-compatible.`, path);
  }
  if (ancestors.has(value)) {
    fail(code, `${path} must not contain cycles.`, path);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item, index) =>
          snapshotJsonValue(item, `${path}[${index}]`, ancestors, code),
        ),
      );
    }
    const output: Record<string, ContextJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = snapshotJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
        code,
      );
    }
    return Object.freeze(output) as ContextJsonObject;
  } finally {
    ancestors.delete(value);
  }
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function jsonByteLength(value: ContextJsonValue): number {
  return utf8Length(JSON.stringify(value));
}
