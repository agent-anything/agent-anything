const MAX_CONTROLLER_CHECKPOINT_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Validate checkpoint data without imposing Action fingerprint limits on retained history. */
export function assertControllerCheckpointValue(value: unknown): void {
  validate(value, "$", 0, new Set<object>());
}

function validate(value: unknown, path: string, depth: number, ancestors: Set<object>): void {
  if (depth > MAX_CONTROLLER_CHECKPOINT_DEPTH) invalid("exceeds logical depth 64", path);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("requires finite numbers", path);
    return;
  }
  if (typeof value !== "object") invalid("requires plain JSON values", path);
  if (ancestors.has(value)) invalid("cannot contain cycles", path);

  const array = Array.isArray(value);
  if (!array) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("requires plain or null-prototype records", path);
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) invalid("requires dense arrays without extra properties", path);
  ancestors.add(value);
  try {
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") invalid("cannot contain symbol properties", path);
      const childPath = array ? `${path}[${key}]` : `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) invalid("cannot contain prototype control keys", childPath);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
        invalid("cannot contain additional array properties", childPath);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalid("requires enumerable data properties", childPath);
      }
      validate(descriptor.value, childPath, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function invalid(reason: string, path: string): never {
  throw new TypeError(`Controller checkpoint ${reason} at ${path}.`);
}
