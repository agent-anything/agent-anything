import { Buffer } from "node:buffer";
import type { McpJsonObject } from "./McpJson.js";
import type { McpTransportKind } from "./McpRegistration.js";

export type McpHeaderValueType = "string" | "integer" | "boolean";

export interface McpToolHeaderBinding {
  readonly argumentPath: readonly string[];
  readonly headerName: string;
  readonly valueType: McpHeaderValueType;
}

export class McpHeaderError extends TypeError {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = "McpHeaderError";
  }
}

const HEADER_NAME_PATTERN =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64_SENTINEL_PATTERN = /^=\?base64\?.*\?=$/s;

export function createMcpToolHeaderBindings(input: {
  readonly schema: McpJsonObject;
  readonly transportKind: McpTransportKind;
  readonly path: string;
}): readonly McpToolHeaderBinding[] {
  if (input.transportKind !== "streamable-http") return Object.freeze([]);

  const bindings: McpToolHeaderBinding[] = [];
  const names = new Set<string>();
  visitSchema(input.schema, {
    schemaPath: input.path,
    argumentPath: Object.freeze([]),
    staticallyReachable: true,
    bindings,
    names,
  });
  bindings.sort((left, right) =>
    compareStrings(left.headerName.toLowerCase(), right.headerName.toLowerCase())
  );
  return Object.freeze(bindings);
}

export function deriveMcpToolParameterHeaders(input: {
  readonly bindings: readonly McpToolHeaderBinding[];
  readonly argumentsValue: McpJsonObject;
}): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const binding of input.bindings) {
    const value = readArgumentPath(input.argumentsValue, binding.argumentPath);
    if (value === undefined || value === null) continue;
    let text: string;
    if (binding.valueType === "string" && typeof value === "string") {
      text = value;
    } else if (
      binding.valueType === "integer" &&
      typeof value === "number" &&
      Number.isSafeInteger(value)
    ) {
      text = value.toString(10);
    } else if (
      binding.valueType === "boolean" &&
      typeof value === "boolean"
    ) {
      text = value ? "true" : "false";
    } else {
      throw new McpHeaderError(
        "MCP Tool argument does not match its x-mcp-header primitive type.",
        `arguments.${binding.argumentPath.join(".")}`,
      );
    }
    headers[binding.headerName] = encodeMcpHeaderValue(text);
  }
  return Object.freeze(headers);
}

export function encodeMcpHeaderValue(input: string): string {
  const plainAscii = /^[\x20-\x7e]*$/.test(input) &&
    input.trim() === input &&
    !BASE64_SENTINEL_PATTERN.test(input);
  return plainAscii
    ? input
    : `=?base64?${Buffer.from(input, "utf8").toString("base64")}?=`;
}

interface VisitState {
  readonly schemaPath: string;
  readonly argumentPath: readonly string[];
  readonly staticallyReachable: boolean;
  readonly bindings: McpToolHeaderBinding[];
  readonly names: Set<string>;
}

function visitSchema(value: unknown, state: VisitState): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      visitSchema(child, {
        ...state,
        schemaPath: `${state.schemaPath}[${index}]`,
        staticallyReachable: false,
      })
    );
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "x-mcp-header")) {
    addBinding(record, state);
  }

  for (const [key, child] of Object.entries(record)) {
    if (key === "x-mcp-header") continue;
    if (
      key === "properties" &&
      state.staticallyReachable &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        visitSchema(propertySchema, {
          ...state,
          schemaPath: `${state.schemaPath}.properties.${propertyName}`,
          argumentPath: Object.freeze([
            ...state.argumentPath,
            propertyName,
          ]),
          staticallyReachable: true,
        });
      }
      continue;
    }
    visitSchema(child, {
      ...state,
      schemaPath: `${state.schemaPath}.${key}`,
      staticallyReachable: false,
    });
  }
}

function addBinding(
  schema: Record<string, unknown>,
  state: VisitState,
): void {
  const annotationPath = `${state.schemaPath}.x-mcp-header`;
  if (!state.staticallyReachable || state.argumentPath.length === 0) {
    throw new McpHeaderError(
      "x-mcp-header must be statically reachable through properties from the schema root.",
      annotationPath,
    );
  }
  const suffix = schema["x-mcp-header"];
  if (
    typeof suffix !== "string" ||
    suffix.length === 0 ||
    suffix.length > 128 ||
    !HEADER_NAME_PATTERN.test(suffix)
  ) {
    throw new McpHeaderError(
      "x-mcp-header must be a bounded HTTP field-name token.",
      annotationPath,
    );
  }
  const valueType = schema.type;
  if (
    valueType !== "string" &&
    valueType !== "integer" &&
    valueType !== "boolean"
  ) {
    throw new McpHeaderError(
      "x-mcp-header is allowed only on string, integer, or boolean parameters.",
      `${state.schemaPath}.type`,
    );
  }
  const headerName = `Mcp-Param-${suffix}`;
  const canonicalName = headerName.toLowerCase();
  if (state.names.has(canonicalName)) {
    throw new McpHeaderError(
      "x-mcp-header names must be case-insensitively unique.",
      annotationPath,
    );
  }
  state.names.add(canonicalName);
  state.bindings.push(Object.freeze({
    argumentPath: Object.freeze([...state.argumentPath]),
    headerName,
    valueType,
  }));
}

function readArgumentPath(
  input: McpJsonObject,
  path: readonly string[],
): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
