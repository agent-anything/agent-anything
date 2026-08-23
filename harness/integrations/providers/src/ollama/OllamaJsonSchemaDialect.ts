import type { ModelOutputFormat } from "@agent-anything/model-interaction/input";

type ModelJsonSchema = Extract<
  ModelOutputFormat,
  { readonly kind: "json_schema" }
>["schema"];
type ModelJsonValue = ModelJsonSchema[string];

export function projectOllamaOutputFormat(
  outputFormat: ModelOutputFormat,
): ModelJsonSchema | null {
  if (outputFormat.kind === "text") {
    return null;
  }
  return "oneOf" in outputFormat.schema
    ? projectDiscriminatedUnion(outputFormat.schema)
    : outputFormat.schema;
}

function projectDiscriminatedUnion(schema: ModelJsonSchema): ModelJsonSchema {
  if (Object.keys(schema).some((key) => key !== "oneOf")) {
    throw unsupportedSchema();
  }
  const oneOf = schema.oneOf;
  if (!Array.isArray(oneOf) || oneOf.length < 2) {
    throw unsupportedSchema();
  }

  const rawVariants = oneOf.map(readRawVariant);
  assertPairwiseExclusive(rawVariants);

  return {
    anyOf: rawVariants.map(projectFieldSchema),
  };
}

function readRawVariant(value: ModelJsonValue): Record<string, ModelJsonValue> {
  if (!isRecord(value)) {
    throw unsupportedSchema();
  }
  if (
    Object.keys(value).some((key) =>
      key !== "type" &&
      key !== "properties" &&
      key !== "required" &&
      key !== "additionalProperties"
    ) ||
    value.type !== "object" ||
    !isRecord(value.properties) ||
    !isStringArray(value.required) ||
    value.additionalProperties !== false
  ) {
    throw unsupportedSchema();
  }
  return value;
}

function assertPairwiseExclusive(
  variants: readonly Record<string, ModelJsonValue>[],
): void {
  for (let leftIndex = 0; leftIndex < variants.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < variants.length; rightIndex += 1) {
      const left = variants[leftIndex];
      const right = variants[rightIndex];
      if (left === undefined || right === undefined || !areMutuallyExclusive(left, right)) {
        throw unsupportedSchema();
      }
    }
  }
}

function areMutuallyExclusive(
  left: Record<string, ModelJsonValue>,
  right: Record<string, ModelJsonValue>,
): boolean {
  const leftProperties = left.properties;
  const rightProperties = right.properties;
  if (
    !isStringArray(left.required) ||
    !isStringArray(right.required) ||
    !isRecord(leftProperties) ||
    !isRecord(rightProperties)
  ) {
    return false;
  }
  const rightRequired = new Set(right.required);
  return left.required.some((name) => {
    if (!rightRequired.has(name)) {
      return false;
    }
    const leftValue = readSingleStringEnum(leftProperties[name]);
    const rightValue = readSingleStringEnum(rightProperties[name]);
    return leftValue !== null && rightValue !== null && leftValue !== rightValue;
  });
}

function readSingleStringEnum(value: ModelJsonValue | undefined): string | null {
  if (!isRecord(value) || value.type !== "string" || !Array.isArray(value.enum)) {
    return null;
  }
  return value.enum.length === 1 && typeof value.enum[0] === "string"
    ? value.enum[0]
    : null;
}

function isStringArray(value: ModelJsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: ModelJsonValue | undefined): value is Record<string, ModelJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectFieldSchema(value: ModelJsonValue): ModelJsonValue {
  if (Array.isArray(value)) {
    return value.map(projectFieldSchema);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !OLLAMA_UNSUPPORTED_REFINEMENT_KEYWORDS.has(key))
      .map(([key, child]) => [key, projectFieldSchema(child)]),
  );
}

const OLLAMA_UNSUPPORTED_REFINEMENT_KEYWORDS = new Set([
  "maxItems",
  "maxLength",
  "minItems",
  "minLength",
]);

function unsupportedSchema(): TypeError {
  return new TypeError("Ollama cannot project the requested JSON Schema into its native schema dialect.");
}
