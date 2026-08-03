import {
  Ajv as AjvDraft7,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolSchemaIdentity } from "@agent-anything/tools";
import {
  createMcpContractFingerprint,
  type McpJsonObject,
  snapshotMcpJsonObject,
} from "./McpJson.js";

export const MCP_JSON_SCHEMA_2020_12 =
  "https://json-schema.org/draft/2020-12/schema" as const;
export const MCP_JSON_SCHEMA_DRAFT_07 =
  "http://json-schema.org/draft-07/schema#" as const;
export const MCP_SCHEMA_TRANSLATION_VERSION = "mcp-2026-07-28-v1" as const;

export type McpJsonSchemaDialect =
  | typeof MCP_JSON_SCHEMA_2020_12
  | typeof MCP_JSON_SCHEMA_DRAFT_07;

export interface McpSchemaValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface McpCompiledSchema {
  readonly schema: McpJsonObject;
  readonly schemaFingerprint: string;
  readonly identity: ToolSchemaIdentity & {
    readonly dialect: McpJsonSchemaDialect;
  };
  validate(value: unknown): McpSchemaValidation;
}

export class McpSchemaError extends TypeError {
  constructor(
    readonly code:
      | "mcp_schema_invalid"
      | "mcp_schema_dialect_unsupported"
      | "mcp_schema_external_ref_unsupported",
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "McpSchemaError";
  }
}

const draft7 = createDraft7Validator();
const draft2020 = createDraft2020Validator();

export function compileMcpSchema(
  input: unknown,
  path: string,
): McpCompiledSchema {
  const schema = snapshotMcpJsonObject(input, path);
  const dialect = resolveDialect(schema, path);
  rejectExternalReferences(schema, path);

  let validate: ValidateFunction;
  try {
    validate = dialect === MCP_JSON_SCHEMA_2020_12
      ? draft2020.compile(schema)
      : draft7.compile(schema);
  } catch (error) {
    throw new McpSchemaError(
      "mcp_schema_invalid",
      error instanceof Error
        ? `MCP JSON Schema compilation failed: ${error.message}`
        : "MCP JSON Schema compilation failed.",
      path,
    );
  }

  const identity = Object.freeze({
    dialect,
    translationVersion: MCP_SCHEMA_TRANSLATION_VERSION,
  });
  return Object.freeze({
    schema,
    schemaFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-json-schema.v1",
      Object.freeze({ dialect, schema }),
    ),
    identity,
    validate(value: unknown): McpSchemaValidation {
      const valid = validate(value) as boolean;
      return Object.freeze({
        valid,
        errors: valid
          ? Object.freeze([])
          : Object.freeze(formatValidationErrors(validate.errors)),
      });
    },
  });
}

function createDraft7Validator(): AjvDraft7 {
  const validator = new AjvDraft7({
    allErrors: true,
    strict: true,
    strictSchema: true,
    validateFormats: false,
    allowUnionTypes: false,
  });
  validator.addKeyword({
    keyword: "x-mcp-header",
    schemaType: "string",
    valid: true,
  });
  return validator;
}

function createDraft2020Validator(): Ajv2020 {
  const validator = new Ajv2020({
    allErrors: true,
    strict: true,
    strictSchema: true,
    validateFormats: false,
    allowUnionTypes: false,
  });
  validator.addKeyword({
    keyword: "x-mcp-header",
    schemaType: "string",
    valid: true,
  });
  return validator;
}

function resolveDialect(
  schema: McpJsonObject,
  path: string,
): McpJsonSchemaDialect {
  const declared = schema.$schema;
  if (declared === undefined) return MCP_JSON_SCHEMA_2020_12;
  if (
    declared === MCP_JSON_SCHEMA_2020_12 ||
    declared === `${MCP_JSON_SCHEMA_2020_12}#`
  ) {
    return MCP_JSON_SCHEMA_2020_12;
  }
  if (
    declared === MCP_JSON_SCHEMA_DRAFT_07 ||
    declared === "https://json-schema.org/draft-07/schema" ||
    declared === "https://json-schema.org/draft-07/schema#"
  ) {
    return MCP_JSON_SCHEMA_DRAFT_07;
  }
  throw new McpSchemaError(
    "mcp_schema_dialect_unsupported",
    "MCP Tool schema dialect is not supported.",
    `${path}.$schema`,
  );
}

function rejectExternalReferences(
  schema: McpJsonObject,
  path: string,
): void {
  const pending: Array<{ readonly value: unknown; readonly path: string }> = [
    { value: schema, path },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) => {
        pending.push({ value, path: `${current.path}[${index}]` });
      });
      continue;
    }
    if (
      current.value === null ||
      typeof current.value !== "object"
    ) {
      continue;
    }
    for (const [key, value] of Object.entries(current.value)) {
      const childPath = `${current.path}.${key}`;
      if (
        key === "$ref" &&
        (
          typeof value !== "string" ||
          !value.startsWith("#")
        )
      ) {
        throw new McpSchemaError(
          "mcp_schema_external_ref_unsupported",
          "MCP Tool schemas cannot resolve external $ref values.",
          childPath,
        );
      }
      pending.push({ value, path: childPath });
    }
  }
}

function formatValidationErrors(
  errors: ErrorObject[] | null | undefined,
): string[] {
  return (errors ?? []).slice(0, 16).map((error) => {
    const location = error.instancePath.length === 0
      ? "/"
      : error.instancePath;
    return `${location}: ${error.message ?? error.keyword}`;
  });
}
