import { createToolContractIdentity } from "@agent-anything/tools/identity";
import type { ToolJsonObject, ToolJsonValue } from "@agent-anything/tools/catalog";
import { toolGuidanceError } from "./HelarcToolGuidanceError.js";

export interface HelarcAnnotatedToolInputSchema {
  readonly schema: ToolJsonObject;
  readonly fieldPointers: readonly string[];
  readonly canonicalShapeDigest: string;
  readonly annotatedShapeDigest: string;
}

export function collectHelarcToolInputFieldPointers(
  schema: ToolJsonObject,
): readonly string[] {
  const snapshot = cloneJsonObject(schema, "inputSchema");
  const pointers = new Set<string>();
  collectPropertyPointers(snapshot, "", pointers);
  return Object.freeze([...pointers].sort(compareStrings));
}

export function annotateHelarcToolInputSchema(input: {
  readonly schema: ToolJsonObject;
  readonly fieldDescriptions: Readonly<Record<string, string>>;
}): HelarcAnnotatedToolInputSchema {
  const canonical = cloneJsonObject(input.schema, "inputSchema");
  const expectedPointers = collectHelarcToolInputFieldPointers(canonical);
  const descriptions = snapshotFieldDescriptions(input.fieldDescriptions);
  const actualPointers = Object.keys(descriptions).sort(compareStrings);
  const missing = expectedPointers.filter((pointer) => !(pointer in descriptions));
  const extra = actualPointers.filter((pointer) => !expectedPointers.includes(pointer));
  if (missing.length > 0 || extra.length > 0) {
    toolGuidanceError(
      "tool_guidance_schema_coverage_invalid",
      `Tool Guidance field descriptions must exactly cover the canonical input fields; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}.`,
      "fieldDescriptions",
    );
  }

  const annotated = cloneJsonObject(canonical, "inputSchema");
  const originalDescriptions = new Map<string, ToolJsonValue | undefined>();
  for (const pointer of actualPointers) {
    const target = resolveJsonPointer(annotated, pointer);
    originalDescriptions.set(
      pointer,
      Object.prototype.hasOwnProperty.call(target, "description")
        ? target.description
        : undefined,
    );
    target.description = descriptions[pointer]!;
  }

  const restored = cloneJsonObject(annotated, "annotatedInputSchema");
  for (const pointer of actualPointers) {
    const target = resolveJsonPointer(restored, pointer);
    const original = originalDescriptions.get(pointer);
    if (original === undefined) delete target.description;
    else target.description = original;
  }

  const canonicalShapeDigest = schemaDigest(canonical);
  if (schemaDigest(restored) !== canonicalShapeDigest) {
    toolGuidanceError(
      "tool_guidance_schema_structure_changed",
      "Product Tool Guidance changed the canonical Tool input Schema shape.",
      "inputSchema",
    );
  }
  const frozenSchema = deepFreeze(annotated) as ToolJsonObject;
  return Object.freeze({
    schema: frozenSchema,
    fieldPointers: Object.freeze(actualPointers),
    canonicalShapeDigest,
    annotatedShapeDigest: schemaDigest(frozenSchema),
  });
}

function collectPropertyPointers(
  value: ToolJsonValue,
  pointer: string,
  output: Set<string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPropertyPointers(item, `${pointer}/${index}`, output));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${escapePointerSegment(key)}`;
    if (key === "properties" && isJsonObject(child)) {
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        const propertyPointer = `${childPointer}/${escapePointerSegment(propertyName)}`;
        output.add(propertyPointer);
        collectPropertyPointers(propertySchema, propertyPointer, output);
      }
    } else {
      collectPropertyPointers(child, childPointer, output);
    }
  }
}

function resolveJsonPointer(
  root: Record<string, ToolJsonValue>,
  pointer: string,
): Record<string, ToolJsonValue> {
  if (!pointer.startsWith("/") || pointer.length < 2 || pointer.includes("\0")) {
    return toolGuidanceError(
      "tool_guidance_schema_pointer_invalid",
      `Tool Guidance JSON Pointer '${pointer}' is invalid.`,
      pointer,
    );
  }
  const segments = pointer.slice(1).split("/").map((segment) => {
    if (/~(?![01])/u.test(segment)) {
      return toolGuidanceError(
        "tool_guidance_schema_pointer_invalid",
        `Tool Guidance JSON Pointer '${pointer}' contains an invalid escape.`,
        pointer,
      );
    }
    return segment.replaceAll("~1", "/").replaceAll("~0", "~");
  });
  let current: ToolJsonValue = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return toolGuidanceError(
        "tool_guidance_schema_pointer_invalid",
        `Tool Guidance JSON Pointer '${pointer}' does not resolve to a Schema object.`,
        pointer,
      );
    }
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment) || Number(segment) >= current.length) {
        return toolGuidanceError(
          "tool_guidance_schema_pointer_invalid",
          `Tool Guidance JSON Pointer '${pointer}' does not resolve to a Schema object.`,
          pointer,
        );
      }
      current = current[Number(segment)]!;
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return toolGuidanceError(
          "tool_guidance_schema_pointer_invalid",
          `Tool Guidance JSON Pointer '${pointer}' does not resolve to a Schema object.`,
          pointer,
        );
      }
      current = (current as ToolJsonObject)[segment]!;
    }
  }
  if (!isJsonObject(current)) {
    return toolGuidanceError(
      "tool_guidance_schema_pointer_invalid",
      `Tool Guidance JSON Pointer '${pointer}' must resolve to a Schema object.`,
      pointer,
    );
  }
  return current as Record<string, ToolJsonValue>;
}

function snapshotFieldDescriptions(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!isPlainRecord(input)) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      "Tool Guidance field descriptions must use a plain object.",
      "fieldDescriptions",
    );
  }
  assertNoAccessors(input, "fieldDescriptions");
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string")) {
    return toolGuidanceError(
      "tool_guidance_source_invalid",
      "Tool Guidance field descriptions cannot contain symbol properties.",
      "fieldDescriptions",
    );
  }
  const output: Record<string, string> = {};
  for (const pointer of Object.keys(input).sort(compareStrings)) {
    const value = input[pointer];
    if (
      typeof value !== "string" || value.trim().length === 0 ||
      value.length > 8_192 || value.includes("\0")
    ) {
      return toolGuidanceError(
        "tool_guidance_source_invalid",
        `Tool Guidance field description '${pointer}' must be bounded non-empty text.`,
        pointer,
      );
    }
    output[pointer] = value;
  }
  return Object.freeze(output);
}

function cloneJsonObject(input: unknown, path: string): Record<string, ToolJsonValue> {
  const value = cloneJson(input, path, new WeakSet());
  if (!isJsonObject(value)) {
    return toolGuidanceError(
      "tool_guidance_schema_structure_changed",
      "A Tool input Schema must be a plain JSON object.",
      path,
    );
  }
  return value as Record<string, ToolJsonValue>;
}

function cloneJson(input: unknown, path: string, ancestors: WeakSet<object>): ToolJsonValue {
  if (input === null || typeof input === "boolean" || typeof input === "string") return input;
  if (typeof input === "number" && Number.isFinite(input)) return Object.is(input, -0) ? 0 : input;
  if (typeof input !== "object") {
    return toolGuidanceError(
      "tool_guidance_schema_structure_changed",
      "A Tool input Schema must contain only JSON values.",
      path,
    );
  }
  if (ancestors.has(input)) {
    return toolGuidanceError(
      "tool_guidance_schema_structure_changed",
      "A Tool input Schema cannot contain cycles.",
      path,
    );
  }
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(input, index)) {
          return toolGuidanceError(
            "tool_guidance_schema_structure_changed",
            "A Tool input Schema cannot contain sparse arrays.",
            path,
          );
        }
      }
      return input.map((value, index) => cloneJson(value, `${path}[${index}]`, ancestors));
    }
    if (!isPlainRecord(input)) {
      return toolGuidanceError(
        "tool_guidance_schema_structure_changed",
        "A Tool input Schema must use plain objects.",
        path,
      );
    }
    assertNoAccessors(input, path);
    if (Reflect.ownKeys(input).some((key) => typeof key !== "string")) {
      return toolGuidanceError(
        "tool_guidance_schema_structure_changed",
        "A Tool input Schema cannot contain symbol properties.",
        path,
      );
    }
    const output: Record<string, ToolJsonValue> = {};
    for (const key of Object.keys(input).sort(compareStrings)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        return toolGuidanceError(
          "tool_guidance_schema_structure_changed",
          "A Tool input Schema contains a forbidden key.",
          `${path}.${key}`,
        );
      }
      output[key] = cloneJson(input[key], `${path}.${key}`, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

function schemaDigest(value: ToolJsonObject): string {
  return createToolContractIdentity("agent-anything.helarc.tool-schema-shape.v1", value);
}

function isJsonObject(input: unknown): input is ToolJsonObject {
  return isPlainRecord(input) && !Array.isArray(input);
}

function isPlainRecord(input: unknown): input is Record<string, any> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function assertNoAccessors(input: Record<string, any>, path: string): void {
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
      toolGuidanceError(
        "tool_guidance_schema_structure_changed",
        "Tool Guidance data cannot contain accessors.",
        `${path}.${String(key)}`,
      );
    }
  }
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input as Record<string, unknown>)) deepFreeze(value);
    Object.freeze(input);
  }
  return input;
}
