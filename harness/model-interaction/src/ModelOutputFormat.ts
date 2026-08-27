import type { ModelJsonValue } from "./ModelInteractionContractValidation.js";
import {
  snapshotJsonValue,
  strictRecord,
  token,
} from "./ModelInteractionContractValidation.js";

export interface StructuredOutputFormat {
  readonly kind: "json_schema";
  readonly name: string;
  readonly schemaId: string;
  readonly schemaRevision: string;
  readonly schema: { readonly [key: string]: ModelJsonValue };
}

export type ModelOutputFormat =
  | { readonly kind: "text" }
  | StructuredOutputFormat;

export function snapshotModelOutputFormat(input: ModelOutputFormat): ModelOutputFormat {
  strictRecord(input as unknown, "ModelOutputFormat", [
    "kind", "name", "schemaId", "schemaRevision", "schema",
  ]);
  if (input.kind === "text") {
    strictRecord(input as unknown, "ModelOutputFormat", ["kind"]);
    return Object.freeze({ kind: "text" });
  }
  if (input.kind !== "json_schema") {
    throw new TypeError("ModelOutputFormat.kind is unsupported.");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.name)) {
    throw new TypeError("ModelOutputFormat.name must be a portable schema name.");
  }
  const schema = snapshotJsonValue(input.schema, "ModelOutputFormat.schema");
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("ModelOutputFormat.schema must be a JSON object.");
  }
  return Object.freeze({
    kind: "json_schema",
    name: input.name,
    schemaId: token(input.schemaId, "ModelOutputFormat.schemaId"),
    schemaRevision: token(input.schemaRevision, "ModelOutputFormat.schemaRevision"),
    schema: schema as { readonly [key: string]: ModelJsonValue },
  });
}
