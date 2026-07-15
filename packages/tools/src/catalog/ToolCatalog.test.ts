import { describe, expect, it } from "vitest";
import {
  createToolCatalogSnapshot,
  findToolDescriptor,
  ToolCatalogValidationError,
  type ToolDescriptorInput,
} from "./ToolCatalog.js";

describe("ToolCatalog", () => {
  it("creates an immutable declarative catalog without execution behavior", () => {
    const inputSchema = {
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
      type: "object",
    };
    const input: ToolDescriptorInput = {
      name: "codeAgent.readFile",
      description: "Read one workspace file.",
      inputSchema,
      annotations: {
        title: "Read file",
        readOnlyHint: true,
        destructiveHint: false,
      },
      metadata: {
        family: "workspace",
        priority: 1,
      },
    };

    const catalog = createToolCatalogSnapshot([input]);
    inputSchema.required[0] = "changed";

    expect(catalog).toEqual({
      schemaVersion: 1,
      tools: [{
        name: "codeAgent.readFile",
        description: "Read one workspace file.",
        inputSchema: {
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object",
        },
        annotations: {
          title: "Read file",
          readOnlyHint: true,
          destructiveHint: false,
        },
        metadata: { family: "workspace", priority: 1 },
      }],
    });
    expect(findToolDescriptor(catalog, "codeAgent.readFile")).toBe(catalog.tools[0]);
    expect("execute" in catalog.tools[0]!).toBe(false);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.tools)).toBe(true);
    expect(Object.isFrozen(catalog.tools[0]!.inputSchema)).toBe(true);
    expect(Object.isFrozen(catalog.tools[0]!.annotations)).toBe(true);
  });

  it("preserves declaration order and rejects duplicate or non-canonical names", () => {
    const first = descriptor("codeAgent.listFiles");
    const second = descriptor("codeAgent.readFile");

    expect(createToolCatalogSnapshot([first, second]).tools.map((tool) => tool.name))
      .toEqual(["codeAgent.listFiles", "codeAgent.readFile"]);
    expect(() => createToolCatalogSnapshot([first, first])).toThrowError(
      expect.objectContaining({ code: "tool_name_duplicate" }),
    );
    expect(() => createToolCatalogSnapshot([descriptor(" readFile")])).toThrowError(
      expect.objectContaining({ code: "tool_name_invalid" }),
    );
  });

  it("rejects unsupported annotations and non-serializable catalog data", () => {
    expect(() => createToolCatalogSnapshot([{
      ...descriptor("codeAgent.readFile"),
      execute: (() => undefined),
    } as never])).toThrowError(expect.objectContaining({ code: "tool_descriptor_invalid" }));

    expect(() => createToolCatalogSnapshot([{
      ...descriptor("codeAgent.readFile"),
      annotations: { risk: "safe" } as never,
    }])).toThrowError(expect.objectContaining({ code: "tool_annotation_invalid" }));

    expect(() => createToolCatalogSnapshot([{
      ...descriptor("codeAgent.readFile"),
      metadata: { execute: (() => undefined) as never },
    }])).toThrowError(expect.objectContaining({ code: "tool_data_not_serializable" }));

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createToolCatalogSnapshot([{
      ...descriptor("codeAgent.readFile"),
      metadata: cyclic as never,
    }])).toThrowError(expect.objectContaining({ code: "tool_data_not_serializable" }));
  });

  it("rejects accessors, class instances, sparse arrays, symbols, and non-finite numbers", () => {
    const withGetter = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "secret",
    });
    expectInvalidMetadata(withGetter);
    expectInvalidMetadata(new Date());

    const sparse: unknown[] = [];
    sparse.length = 1;
    expectInvalidMetadata({ sparse });
    expectInvalidMetadata({ value: Number.POSITIVE_INFINITY });

    const symbolData = { value: true } as Record<PropertyKey, unknown>;
    symbolData[Symbol("hidden")] = true;
    expectInvalidMetadata(symbolData);
  });

  it("reports catalog validation paths", () => {
    try {
      createToolCatalogSnapshot([{
        ...descriptor("codeAgent.readFile"),
        metadata: { nested: { value: undefined as never } },
      }]);
      expect.fail("Expected catalog validation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolCatalogValidationError);
      expect(error).toMatchObject({
        code: "tool_data_not_serializable",
        path: "tools[0].metadata.nested.value",
      });
    }
  });

  it("rejects sparse catalogs and descriptor accessors", () => {
    const sparse: ToolDescriptorInput[] = [];
    sparse.length = 1;
    expect(() => createToolCatalogSnapshot(sparse)).toThrowError(
      expect.objectContaining({ code: "tool_descriptor_invalid" }),
    );

    const descriptorWithGetter = Object.defineProperty({}, "name", {
      enumerable: true,
      get: () => "codeAgent.readFile",
    });
    expect(() => createToolCatalogSnapshot([descriptorWithGetter as never])).toThrowError(
      expect.objectContaining({ code: "tool_data_not_serializable" }),
    );
  });
});

function descriptor(name: string): ToolDescriptorInput {
  return {
    name,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function expectInvalidMetadata(metadata: unknown): void {
  expect(() => createToolCatalogSnapshot([{
    ...descriptor("codeAgent.readFile"),
    metadata: metadata as never,
  }])).toThrowError(expect.objectContaining({ code: "tool_data_not_serializable" }));
}
