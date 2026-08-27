import { createHash } from "node:crypto";
import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import {
  snapshotJsonValue,
  strictRecord,
} from "./ModelInteractionContractValidation.js";

const MAX_CALLABLE_DESCRIPTION_LENGTH = 8_192;
const MAX_CALLABLE_SCHEMA_BYTES = 131_072;
const MAX_CALLABLE_COUNT = 128;

export type ModelJsonSchema = { readonly [key: string]: ModelJsonValue };

export interface ModelCallableDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ModelJsonSchema;
}

export function snapshotModelCallableDefinition(
  input: ModelCallableDefinition,
): ModelCallableDefinition {
  strictRecord(input, "ModelCallableDefinition", [
    "name", "description", "inputSchema",
  ]);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(input.name)) {
    throw new TypeError("ModelCallableDefinition.name must be a portable callable name.");
  }
  if (
    typeof input.description !== "string" ||
    input.description.trim().length === 0 ||
    input.description.length > MAX_CALLABLE_DESCRIPTION_LENGTH
  ) {
    throw new TypeError("ModelCallableDefinition.description is invalid or too large.");
  }
  const schema = snapshotJsonValue(
    input.inputSchema,
    "ModelCallableDefinition.inputSchema",
  );
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("ModelCallableDefinition.inputSchema must be a JSON object.");
  }
  if (utf8Length(JSON.stringify(schema)) > MAX_CALLABLE_SCHEMA_BYTES) {
    throw new TypeError("ModelCallableDefinition.inputSchema is too large.");
  }
  return Object.freeze({
    name: input.name,
    description: input.description,
    inputSchema: schema as ModelJsonSchema,
  });
}

export function snapshotModelCallableDefinitions(
  input: readonly ModelCallableDefinition[],
): readonly ModelCallableDefinition[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CALLABLE_COUNT) {
    throw new TypeError("Model callable definitions must be a bounded non-empty array.");
  }
  const definitions = input
    .map(snapshotModelCallableDefinition)
    .sort((left, right) => comparePortableNames(left.name, right.name));
  if (new Set(definitions.map((definition) => definition.name)).size !== definitions.length) {
    throw new TypeError("Model callable definition names must be unique.");
  }
  return Object.freeze(definitions);
}

export function modelCallableDefinitionsContentDigest(
  definitions: readonly ModelCallableDefinition[],
): string {
  const snapshot = snapshotModelCallableDefinitions(definitions);
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(snapshot), "utf8")
    .digest("hex")}`;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function comparePortableNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
