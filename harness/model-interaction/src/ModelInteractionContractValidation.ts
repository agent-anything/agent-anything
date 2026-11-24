// Shared strict snapshot helpers for Model Interaction Contracts.
// Owned snapshots may bypass copying; stable sources still need initial validation.
const ownedJson = new WeakSet<object>();
const stableInputs = new WeakSet<object>();
const inputSnapshots = new WeakMap<object,ModelJsonValue>();

/** Prove the whole plain-data graph, never just the root's frozen flag. */
export function isStableModelJsonInput(value:unknown, ancestors=new Set<object>()):boolean {
  if(value===null||typeof value!=="object")return true;
  if(ownedJson.has(value)||stableInputs.has(value))return true;
  if(ancestors.has(value)||!Object.isFrozen(value))return false;
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)return false;
  ancestors.add(value);
  try {
    for(const key of Reflect.ownKeys(value)) {
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!("value" in descriptor)||!isStableModelJsonInput(descriptor.value,ancestors))return false;
    }
    stableInputs.add(value);
    return true;
  } finally {ancestors.delete(value);}
}

export function strictRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path} contains unsupported field '${key}'.`);
    }
  }
}

export function token(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

export function nullableToken(value: unknown, path: string): string | null {
  return value === null ? null : token(value, path);
}

export function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}

export function isoDateTime(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${path} must be an ISO date-time string.`);
  }
  return value;
}

export function snapshotJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): ModelJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must be JSON-compatible.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain cycles.`);
  }
  if (ownedJson.has(value)) return value as ModelJsonValue;
  const saved=inputSnapshots.get(value);
  if(saved!==undefined)return saved;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output = Object.freeze(
        value.map((item, index) =>
          snapshotJsonValue(item, `${path}[${index}]`, ancestors),
        ),
      );
      ownedJson.add(output);
      if(isStableModelJsonInput(value))inputSnapshots.set(value,output);
      return output;
    }
    const output: Record<string, ModelJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(output, key, {enumerable: true, value: snapshotJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      )});
    }
    Object.freeze(output);
    ownedJson.add(output);
    if(isStableModelJsonInput(value))inputSnapshots.set(value,output);
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export type ModelJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ModelJsonValue[]
  | { readonly [key: string]: ModelJsonValue };
