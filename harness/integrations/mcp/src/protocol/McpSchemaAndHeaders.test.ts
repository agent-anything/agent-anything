import { describe, expect, it } from "vitest";
import {
  createMcpToolHeaderBindings,
  deriveMcpToolParameterHeaders,
  encodeMcpHeaderValue,
} from "./McpHeaders.js";
import {
  compileMcpSchema,
  MCP_JSON_SCHEMA_2020_12,
  MCP_JSON_SCHEMA_DRAFT_07,
} from "./McpSchema.js";

describe("MCP JSON Schema adapter", () => {
  it("defaults to 2020-12 and supports an explicit draft-07 schema", () => {
    const current = compileMcpSchema({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
      additionalProperties: false,
    }, "schema");
    const draft7 = compileMcpSchema({
      $schema: MCP_JSON_SCHEMA_DRAFT_07,
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    }, "schema");

    expect(current.identity.dialect).toBe(MCP_JSON_SCHEMA_2020_12);
    expect(current.validate({ count: 1 }).valid).toBe(true);
    expect(current.validate({ count: "1" }).valid).toBe(false);
    expect(draft7.identity.dialect).toBe(MCP_JSON_SCHEMA_DRAFT_07);
    expect(draft7.validate({ enabled: true }).valid).toBe(true);
  });

  it("rejects external references instead of resolving network schemas", () => {
    expect(() => compileMcpSchema({
      type: "object",
      properties: {
        value: { $ref: "https://schemas.example/value.json" },
      },
    }, "schema")).toThrow("cannot resolve external $ref");
  });
});

describe("MCP parameter header adaptation", () => {
  it("derives nested primitive headers and uses the exact Base64 sentinel", () => {
    const bindings = createMcpToolHeaderBindings({
      transportKind: "streamable-http",
      path: "schema",
      schema: {
        type: "object",
        properties: {
          request: {
            type: "object",
            properties: {
              label: {
                type: "string",
                "x-mcp-header": "Label",
              },
              retries: {
                type: "integer",
                "x-mcp-header": "Retries",
              },
              enabled: {
                type: "boolean",
                "x-mcp-header": "Enabled",
              },
            },
          },
        },
      },
    });
    const headers = deriveMcpToolParameterHeaders({
      bindings,
      argumentsValue: {
        request: {
          label: "你好",
          retries: 2,
          enabled: false,
        },
      },
    });

    expect(headers).toEqual({
      "Mcp-Param-Enabled": "false",
      "Mcp-Param-Label": "=?base64?5L2g5aW9?=",
      "Mcp-Param-Retries": "2",
    });
    expect(encodeMcpHeaderValue("=?base64?literal?=")).toBe(
      "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=",
    );
  });

  it("rejects dynamic paths and case-insensitive duplicate names", () => {
    expect(() => createMcpToolHeaderBindings({
      transportKind: "streamable-http",
      path: "schema",
      schema: {
        type: "object",
        allOf: [{
          properties: {
            token: {
              type: "string",
              "x-mcp-header": "Token",
            },
          },
        }],
      },
    })).toThrow("statically reachable through properties");

    expect(() => createMcpToolHeaderBindings({
      transportKind: "streamable-http",
      path: "schema",
      schema: {
        type: "object",
        properties: {
          first: {
            type: "string",
            "x-mcp-header": "Trace",
          },
          second: {
            type: "string",
            "x-mcp-header": "trace",
          },
        },
      },
    })).toThrow("case-insensitively unique");
  });
});
