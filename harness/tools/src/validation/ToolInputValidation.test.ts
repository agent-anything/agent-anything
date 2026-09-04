import { describe, expect, it } from "vitest";
import { createToolCatalogSnapshot, ToolCatalogValidationError } from "../catalog/index.js";
import type { ToolDescriptor, ToolDescriptorInput } from "../catalog/index.js";
import { validateToolInput } from "./ToolInputValidation.js";

describe("Tool input validation", () => {
  it("compiles draft-2020 input schemas during catalog admission", () => {
    expect(() => createToolCatalogSnapshot([
      descriptor({ type: "not-a-json-schema-type" }),
    ])).toThrowError(ToolCatalogValidationError);

    try {
      createToolCatalogSnapshot([descriptor({ type: "not-a-json-schema-type" })]);
    } catch (error) {
      expect(error).toMatchObject({
        code: expect.stringMatching(/^tool_input_schema_/),
        path: "tools[0].inputSchema",
      });
    }
  });

  it("normalizes bounded field-specific issues without rejected values", () => {
    const tool = admittedDescriptor({
      type: "object",
      additionalProperties: false,
      required: ["path", "count"],
      properties: {
        path: { type: "string", minLength: 1 },
        count: { type: "integer", minimum: 1 },
      },
    });
    const result = validateToolInput({
      descriptor: tool,
      value: { count: "secret-rejected-value", extra: "do-not-project" },
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.failure.issues).toEqual([
      expect.objectContaining({ path: "/count", reason: "type", received: "string" }),
      expect.objectContaining({ path: "/extra", reason: "unexpected", received: "string" }),
      expect.objectContaining({ path: "/path", reason: "required", received: "missing" }),
    ]);
    expect(result.message).not.toContain("secret-rejected-value");
    expect(result.message).not.toContain("do-not-project");
    expect(result.message.length).toBeLessThanOrEqual(4_096);
  });

  it("runs an exact-revision semantic validator only after shape validity", () => {
    const tool = admittedDescriptor({
      type: "object",
      additionalProperties: false,
      required: ["start", "end"],
      properties: {
        start: { type: "integer" },
        end: { type: "integer" },
      },
    });
    let calls = 0;
    const validator = Object.freeze({
      ref: Object.freeze({ id: "range-order", revision: "1" }),
      tool: tool.ref,
      validate(input: unknown) {
        calls += 1;
        const value = input as { readonly start: number; readonly end: number };
        return value.start <= value.end
          ? Object.freeze({ status: "valid" as const })
          : Object.freeze({
              status: "invalid" as const,
              issues: Object.freeze([Object.freeze({
                path: "/end",
                reason: "constraint" as const,
                expected: "a value greater than or equal to start",
                received: "integer" as const,
                hint: "Correct the range order.",
              })]),
            });
      },
    });

    expect(validateToolInput({
      descriptor: tool,
      value: { start: "invalid", end: 1 },
      semanticValidators: [validator],
    }).status).toBe("invalid");
    expect(calls).toBe(0);
    expect(validateToolInput({
      descriptor: tool,
      value: { start: 2, end: 1 },
      semanticValidators: [validator],
    })).toEqual(expect.objectContaining({ status: "invalid" }));
    expect(calls).toBe(1);
  });
});

function admittedDescriptor(schema: Readonly<Record<string, unknown>>): ToolDescriptor {
  return createToolCatalogSnapshot([descriptor(schema)]).tools[0]!;
}

function descriptor(
  inputSchema: Readonly<Record<string, unknown>>,
): ToolDescriptorInput {
  return {
    ref: {
      tool: { namespace: "test", name: "range" },
      revision: "1",
    },
    name: "test.range",
    inputSchema: inputSchema as ToolDescriptorInput["inputSchema"],
    schemaRevisions: {
      dialect: "json-schema-2020-12",
      input: "1",
      output: null,
      translation: "native-1",
    },
    source: {
      kind: "harness",
      sourceId: "test",
      sourceRevision: "1",
      activationEpoch: null,
    },
    binding: {
      kind: "interaction",
      protocol: { owner: "test", kind: "range", revision: "1" },
      blockingScope: "none",
      revision: "1",
    },
  };
}
