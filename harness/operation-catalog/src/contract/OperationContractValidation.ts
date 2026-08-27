export type OperationContractValidationCode =
  | "operation_contract_invalid"
  | "operation_identity_invalid"
  | "operation_duplicate"
  | "operation_binding_invalid"
  | "operation_catalog_invalid";

export class OperationContractValidationError extends TypeError {
  constructor(
    readonly code: OperationContractValidationCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "OperationContractValidationError";
  }
}

export function fail(
  code: OperationContractValidationCode,
  message: string,
  path: string,
): never {
  throw new OperationContractValidationError(code, message, path);
}

export function token(value: unknown, path: string, maximumLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value)
  ) {
    fail("operation_identity_invalid", `A canonical token is required at ${path}.`, path);
  }
  return value;
}

export function dateTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("operation_contract_invalid", `A date-time is required at ${path}.`, path);
  }
  return value;
}

export function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
  code: OperationContractValidationCode = "operation_contract_invalid",
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(code, `A plain object is required at ${path}.`, path);
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail(code, `Unsupported field at ${path}.${String(key)}.`, `${path}.${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || !descriptor?.enumerable) {
      fail(code, `Enumerable data property required at ${path}.${key}.`, `${path}.${key}`);
    }
  }
}

export function denseArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) fail("operation_contract_invalid", `An array is required at ${path}.`, path);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      fail("operation_contract_invalid", `Unsupported array property at ${path}.`, path);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail("operation_contract_invalid", `Sparse entry at ${path}[${index}].`, `${path}[${index}]`);
  }
}

export function uniqueSorted<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: string,
): readonly T[] {
  const sorted = [...values].sort((left, right) => key(left).localeCompare(key(right)));
  for (let index = 1; index < sorted.length; index += 1) {
    if (key(sorted[index - 1]!) === key(sorted[index]!)) {
      fail("operation_duplicate", `Duplicate identity '${key(sorted[index]!)}'.`, path);
    }
  }
  return Object.freeze(sorted);
}
