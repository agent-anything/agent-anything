export type InteractionContractErrorCode =
  | "interaction_contract_invalid"
  | "interaction_protocol_invalid"
  | "interaction_protocol_duplicate";

export class InteractionContractError extends TypeError {
  constructor(
    readonly code: InteractionContractErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "InteractionContractError";
  }
}

export function fail(code: InteractionContractErrorCode, message: string, path: string): never {
  throw new InteractionContractError(code, message, path);
}

export function token(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value)
  ) fail("interaction_contract_invalid", `A canonical token is required at ${path}.`, path);
  return value;
}

export function dateTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("interaction_contract_invalid", `A date-time is required at ${path}.`, path);
  }
  return value;
}

export function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("interaction_contract_invalid", `A positive integer is required at ${path}.`, path);
  }
  return value as number;
}

export function strictRecord(value: unknown, path: string, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail("interaction_contract_invalid", `A plain object is required at ${path}.`, path);
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail("interaction_contract_invalid", `Unsupported field at ${path}.${String(key)}.`, `${path}.${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || !descriptor?.enumerable) {
      fail("interaction_contract_invalid", `Enumerable data property required at ${path}.${key}.`, `${path}.${key}`);
    }
  }
}

export function denseArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) fail("interaction_contract_invalid", `An array is required at ${path}.`, path);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail("interaction_contract_invalid", `Sparse entry at ${path}[${index}].`, `${path}[${index}]`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      fail("interaction_contract_invalid", `Unsupported array property at ${path}.`, path);
    }
  }
}
