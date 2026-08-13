export function assertStrictRecord(
  value: unknown,
  field: string,
  allowedKeys: ReadonlySet<string>,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${field} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new TypeError(`${field}.${String(key)} is unsupported.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${field}.${key} must be an enumerable data property.`);
    }
  }
}

export function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${field} must be non-empty canonical text.`);
  }
}

export function assertDenseArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      throw new TypeError(`${field} contains an unsupported property.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${field} must not be sparse.`);
    }
  }
}

export function snapshotData(value: unknown, field: string, depth = 0): unknown {
  if (depth > 32) throw new TypeError(`${field} exceeds the supported nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    assertDenseArray(value, field);
    return Object.freeze(value.map((entry, index) => snapshotData(entry, `${field}[${index}]`, depth + 1)));
  }
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} must contain only structured data.`);
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || !descriptor?.enumerable) {
      throw new TypeError(`${field}.${key} must be an enumerable data property.`);
    }
    output[key] = snapshotData((value as Record<string, unknown>)[key], `${field}.${key}`, depth + 1);
  }
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
    throw new TypeError(`${field} must not contain symbol properties.`);
  }
  return Object.freeze(output);
}
