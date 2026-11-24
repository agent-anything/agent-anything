import { createHash } from "node:crypto";
import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import {
  snapshotJsonValue,
  isStableModelJsonInput,
  strictRecord,
} from "./ModelInteractionContractValidation.js";

const MAX_CALLABLE_DESCRIPTION_LENGTH = 8_192;
const MAX_CALLABLE_SCHEMA_BYTES = 131_072;
const MAX_CALLABLE_COUNT = 128;
const ownedDefinitions = new WeakSet<object>();
const ownedLists = new WeakSet<object>();
const schemaBytes = new WeakMap<object,number>();
const sourceDefinitions = new WeakMap<object,ModelCallableDefinition>();
const sourceLists = new WeakMap<object,readonly ModelCallableDefinition[]>();
const listDigests = new WeakMap<object,string>();

export type ModelJsonSchema = { readonly [key: string]: ModelJsonValue };

export interface ModelCallableDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ModelJsonSchema;
}

export function snapshotModelCallableDefinition(
  input: ModelCallableDefinition,
): ModelCallableDefinition {
  if (ownedDefinitions.has(input)) return input;
  const retained=sourceDefinitions.get(input);
  if(retained)return retained;
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
  const bytes=schemaBytes.get(schema)??utf8Length(JSON.stringify(schema));
  if (bytes > MAX_CALLABLE_SCHEMA_BYTES) {
    throw new TypeError("ModelCallableDefinition.inputSchema is too large.");
  }
  schemaBytes.set(schema,bytes);
  const result=Object.freeze({
    name: input.name,
    description: input.description,
    inputSchema: schema as ModelJsonSchema,
  });
  ownedDefinitions.add(result);
  if(isStableModelJsonInput(input))sourceDefinitions.set(input,result);
  return result;
}

export function snapshotModelCallableDefinitions(
  input: readonly ModelCallableDefinition[],
): readonly ModelCallableDefinition[] {
  if(ownedLists.has(input))return input;
  const retained=sourceLists.get(input);
  if(retained)return retained;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CALLABLE_COUNT) {
    throw new TypeError("Model callable definitions must be a bounded non-empty array.");
  }
  const definitions = input
    .map(snapshotModelCallableDefinition)
    .sort((left, right) => comparePortableNames(left.name, right.name));
  if (new Set(definitions.map((definition) => definition.name)).size !== definitions.length) {
    throw new TypeError("Model callable definition names must be unique.");
  }
  Object.freeze(definitions);
  ownedLists.add(definitions);
  if(isStableModelJsonInput(input))sourceLists.set(input,definitions);
  return definitions;
}

export function modelCallableDefinitionsContentDigest(
  definitions: readonly ModelCallableDefinition[],
): string {
  const snapshot = snapshotModelCallableDefinitions(definitions);
  const retained=listDigests.get(snapshot);
  if(retained)return retained;
  const digest=`sha256:${createHash("sha256")
    .update(JSON.stringify(snapshot), "utf8")
    .digest("hex")}`;
  listDigests.set(snapshot,digest);
  return digest;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function comparePortableNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
