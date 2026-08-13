import { describe, expect, it } from "vitest";
import {
  createToolCatalogSnapshot,
  findToolDescriptor,
  ToolCatalogValidationError,
  type ToolDescriptorInput,
} from "./ToolCatalog.js";

describe("ToolCatalog", () => {
  it("captures one immutable revisioned descriptor without execution behavior", () => {
    const inputSchema = {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    };
    const input: ToolDescriptorInput = {
      ...descriptor("codeAgent.readFile"),
      description: "Read one workspace file.",
      inputSchema,
      annotations: {
        title: "Read file",
        readOnlyHint: true,
        destructiveHint: false,
      },
      metadata: { family: "workspace", priority: 1 },
    };

    const catalog = createToolCatalogSnapshot([input]);
    inputSchema.required[0] = "changed";

    expect(catalog).toMatchObject({
      schemaVersion: 2,
      tools: [{
        ref: { tool: { namespace: "code-agent", name: "read-file" }, revision: "1" },
        name: "codeAgent.readFile",
        inputSchema: { required: ["path"] },
        schemaRevisions: {
          dialect: "json-schema-2020-12",
          input: "input-1",
          output: null,
          translation: "native-1",
        },
        source: {
          kind: "product",
          sourceId: "helarc-code-agent",
          sourceRevision: "1",
          activationEpoch: null,
        },
        operationBinding: {
          operation: {
            operation: { namespace: "code", name: "read-file" },
            revision: "1",
          },
          revision: "binding-1",
        },
      }],
    });
    expect(catalog.catalogId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(catalog.revision).toBe(catalog.catalogId);
    expect(findToolDescriptor(catalog, "codeAgent.readFile", "1")).toBe(catalog.tools[0]);
    expect("execute" in catalog.tools[0]!).toBe(false);
    expect(Object.isFrozen(catalog.tools[0]!.source)).toBe(true);
    expect(Object.isFrozen(catalog.tools[0]!.inputSchema)).toBe(true);
  });

  it("uses canonical revision order and rejects duplicate revisions or names", () => {
    const first = descriptor("codeAgent.listFiles");
    const second = descriptor("codeAgent.readFile");
    expect(createToolCatalogSnapshot([second, first]).tools.map((tool) => tool.name))
      .toEqual(["codeAgent.listFiles", "codeAgent.readFile"]);
    expect(() => createToolCatalogSnapshot([first, first])).toThrowError(
      expect.objectContaining({ code: "tool_revision_duplicate" }),
    );
    expect(() => createToolCatalogSnapshot([
      first,
      { ...first, ref: { ...first.ref, revision: "2" } },
    ])).toThrowError(expect.objectContaining({ code: "tool_name_duplicate" }));
    expect(() => createToolCatalogSnapshot([
      { ...first, name: " codeAgent.listFiles" },
    ])).toThrowError(expect.objectContaining({ code: "tool_identity_invalid" }));
  });

  it("rejects unsupported fields and non-serializable catalog data", () => {
    expect(() => createToolCatalogSnapshot([{
      ...descriptor("codeAgent.readFile"),
      execute: () => undefined,
    } as never])).toThrowError(expect.objectContaining({ code: "tool_descriptor_invalid" }));
    expect(() => createToolCatalogSnapshot([{
      ...descriptor("codeAgent.readFile"),
      annotations: { risk: "safe" },
    } as never])).toThrowError(expect.objectContaining({ code: "tool_descriptor_invalid" }));
    expectInvalidMetadata({ execute: () => undefined });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectInvalidMetadata(cyclic);
  });

  it("rejects accessors, class instances, sparse arrays, symbols, and non-finite numbers", () => {
    expectInvalidMetadata(Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "secret",
    }));
    expectInvalidMetadata(new Date());
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectInvalidMetadata({ sparse });
    expectInvalidMetadata({ value: Number.POSITIVE_INFINITY });
    const symbolData = { value: true } as Record<PropertyKey, unknown>;
    symbolData[Symbol("hidden")] = true;
    expectInvalidMetadata(symbolData);
  });

  it("reports the exact invalid data path", () => {
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
  const operationName = name.endsWith("listFiles") ? "list-files" : "read-file";
  const toolName = name.endsWith("listFiles") ? "list-files" : "read-file";
  return {
    ref: { tool: { namespace: "code-agent", name: toolName }, revision: "1" },
    name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    schemaRevisions: {
      dialect: "json-schema-2020-12",
      input: "input-1",
      output: null,
      translation: "native-1",
    },
    source: {
      kind: "product",
      sourceId: "helarc-code-agent",
      sourceRevision: "1",
      activationEpoch: null,
    },
    operationBinding: {
      operation: {
        operation: { namespace: "code", name: operationName },
        revision: "1",
      },
      revision: "binding-1",
    },
  };
}

function expectInvalidMetadata(metadata: unknown): void {
  expect(() => createToolCatalogSnapshot([{
    ...descriptor("codeAgent.readFile"),
    metadata: metadata as never,
  }])).toThrowError(expect.objectContaining({ code: "tool_data_not_serializable" }));
}
