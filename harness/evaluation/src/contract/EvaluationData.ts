export type EvaluationDataPrimitive = string | number | boolean | null;

export type EvaluationDataValue =
  | EvaluationDataPrimitive
  | EvaluationDataObject
  | readonly EvaluationDataValue[];

export interface EvaluationDataObject {
  readonly [key: string]: EvaluationDataValue;
}

export type EvaluationContractErrorCode =
  | "evaluation_data_invalid"
  | "evaluation_data_too_deep"
  | "evaluation_data_too_large"
  | "evaluation_identity_invalid"
  | "evaluation_reference_invalid"
  | "evaluation_revision_invalid"
  | "evaluation_time_invalid"
  | "evaluation_definition_invalid";

export class EvaluationContractError extends TypeError {
  readonly code: EvaluationContractErrorCode;
  readonly path: string;

  constructor(
    code: EvaluationContractErrorCode,
    message: string,
    path: string,
  ) {
    super(message);
    this.name = "EvaluationContractError";
    this.code = code;
    this.path = path;
  }
}

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_BYTES = 1_000_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface SnapshotState {
  readonly ancestors: Set<object>;
  nodes: number;
}

export function snapshotEvaluationData(
  input: unknown,
  path = "EvaluationData",
): EvaluationDataValue {
  const result = snapshotValue(input, path, 0, {
    ancestors: new Set<object>(),
    nodes: 0,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > MAX_BYTES) {
    throw contractError(
      "evaluation_data_too_large",
      `${path} exceeds ${MAX_BYTES} UTF-8 bytes.`,
      path,
    );
  }
  return result;
}

export function snapshotEvaluationDataObject(
  input: unknown,
  path: string,
): EvaluationDataObject {
  const value = snapshotEvaluationData(input, path);
  if (!isEvaluationDataObject(value)) {
    throw contractError(
      "evaluation_data_invalid",
      `${path} must be a plain JSON-safe object.`,
      path,
    );
  }
  return value;
}

export function isEvaluationDataObject(
  input: EvaluationDataValue,
): input is EvaluationDataObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export function assertSafeProjectionData(
  input: EvaluationDataValue,
  path = "Projection",
): void {
  inspectSafeProjection(input, path);
}

function snapshotValue(
  input: unknown,
  path: string,
  depth: number,
  state: SnapshotState,
): EvaluationDataValue {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw contractError(
      "evaluation_data_too_large",
      `${path} exceeds ${MAX_NODES} values.`,
      path,
    );
  }
  if (depth > MAX_DEPTH) {
    throw contractError(
      "evaluation_data_too_deep",
      `${path} exceeds depth ${MAX_DEPTH}.`,
      path,
    );
  }

  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw contractError(
        "evaluation_data_invalid",
        `${path} must not contain a non-finite number.`,
        path,
      );
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object") {
    throw contractError(
      "evaluation_data_invalid",
      `${path} contains a value that is not JSON-safe.`,
      path,
    );
  }
  if (state.ancestors.has(input)) {
    throw contractError(
      "evaluation_data_invalid",
      `${path} contains a cycle.`,
      path,
    );
  }

  state.ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      assertArrayShape(input, path);
      const values: EvaluationDataValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) {
          throw contractError(
            "evaluation_data_invalid",
            `${path} must not contain sparse array entries.`,
            `${path}[${index}]`,
          );
        }
        assertDataProperty(input, String(index), `${path}[${index}]`);
        values.push(snapshotValue(input[index], `${path}[${index}]`, depth + 1, state));
      }
      return Object.freeze(values);
    }

    assertPlainRecord(input, path);
    const result: Record<string, EvaluationDataValue> = {};
    const keys = Object.keys(input).sort(compareText);
    if (Reflect.ownKeys(input).length !== keys.length) {
      throw contractError(
        "evaluation_data_invalid",
        `${path} must contain only string data properties.`,
        path,
      );
    }
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(key)) {
        throw contractError(
          "evaluation_data_invalid",
          `${childPath} uses a forbidden key.`,
          childPath,
        );
      }
      assertDataProperty(input, key, childPath);
      result[key] = snapshotValue(
        (input as Record<string, unknown>)[key],
        childPath,
        depth + 1,
        state,
      );
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(input);
  }
}

function inspectSafeProjection(input: EvaluationDataValue, path: string): void {
  if (typeof input === "string") {
    if (
      /^[A-Za-z]:[\\/]/.test(input) ||
      /^\\\\/.test(input) ||
      /^file:\/\//i.test(input) ||
      /^\/(?:tmp|home|users|var|private|opt|etc)(?:\/|$)/i.test(input)
    ) {
      throw contractError(
        "evaluation_data_invalid",
        `${path} contains a physical filesystem path.`,
        path,
      );
    }
    return;
  }
  if (input === null || typeof input !== "object") return;
  if (Array.isArray(input)) {
    input.forEach((item, index) => inspectSafeProjection(item, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (
      /^(?:prompt|systemPrompt|userPrompt|credential|credentials|password|secret|apiKey|accessToken|refreshToken|bearerToken|tokenValue|physicalRoot|rootPath|fileHandle|runState|rendererState)$/i.test(
        key,
      )
    ) {
      throw contractError(
        "evaluation_data_invalid",
        `${path}.${key} is not admitted in a safe Evaluation Projection.`,
        `${path}.${key}`,
      );
    }
    inspectSafeProjection(value, `${path}.${key}`);
  }
}

function assertArrayShape(input: readonly unknown[], path: string): void {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      throw contractError(
        "evaluation_data_invalid",
        `${path} contains a symbol property.`,
        path,
      );
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
      throw contractError(
        "evaluation_data_invalid",
        `${path}.${key} is not an array data entry.`,
        `${path}.${key}`,
      );
    }
  }
}

function assertPlainRecord(
  input: object,
  path: string,
): asserts input is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw contractError(
      "evaluation_data_invalid",
      `${path} must be a plain object.`,
      path,
    );
  }
}

function assertDataProperty(input: object, key: PropertyKey, path: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    throw contractError(
      "evaluation_data_invalid",
      `${path} must be an enumerable data property.`,
      path,
    );
  }
}

export function contractError(
  code: EvaluationContractErrorCode,
  message: string,
  path: string,
): EvaluationContractError {
  return new EvaluationContractError(code, message, path);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
