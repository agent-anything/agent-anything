import { describe, expect, it } from "vitest";
import { createToolRegistrationSnapshot } from "../registration/index.js";
import {
  createToolSelectionSnapshot,
  findSelectedTool,
} from "./ToolSelection.js";

describe("ToolSelection", () => {
  it("separates model exposure from workflow-only Tools", () => {
    const registrations = createToolRegistrationSnapshot([
      registration("codeAgent.readFile"),
      registration("codeAgent.createFile"),
    ]);
    const selection = createToolSelectionSnapshot(registrations, [
      { toolName: "codeAgent.readFile", origins: ["model"] },
      { toolName: "codeAgent.createFile", origins: ["workflow"] },
    ]);

    expect(selection.modelCatalog.tools.map((tool) => tool.name)).toEqual([
      "codeAgent.readFile",
    ]);
    expect(findSelectedTool(selection, "codeAgent.readFile", "model")).toBeDefined();
    expect(findSelectedTool(selection, "codeAgent.createFile", "model")).toBeUndefined();
    expect(findSelectedTool(selection, "codeAgent.createFile", "workflow")).toBeDefined();
    expect(selection.selectionId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects unknown Tools, duplicate selections, and empty origins", () => {
    const registrations = createToolRegistrationSnapshot([
      registration("codeAgent.readFile"),
    ]);
    expect(() => createToolSelectionSnapshot(registrations, [{
      toolName: "codeAgent.missing",
      origins: ["model"],
    }])).toThrowError(expect.objectContaining({ code: "tool_selection_unknown" }));
    expect(() => createToolSelectionSnapshot(registrations, [
      { toolName: "codeAgent.readFile", origins: ["model"] },
      { toolName: "codeAgent.readFile", origins: ["workflow"] },
    ])).toThrowError(expect.objectContaining({ code: "tool_selection_duplicate" }));
    expect(() => createToolSelectionSnapshot(registrations, [{
      toolName: "codeAgent.readFile",
      origins: [],
    }])).toThrowError(expect.objectContaining({
      code: "tool_selection_origin_invalid",
    }));
  });
});

function registration(name: string) {
  return {
    descriptor: {
      name,
      inputSchema: { type: "object", properties: {} },
    },
    source: {
      kind: "product" as const,
      sourceId: "helarc-code-agent",
      sourceRevision: "1",
      activationEpoch: null,
      capabilityId: name,
    },
    schema: {
      dialect: "json-schema-2020-12",
      translationVersion: "native-v1",
    },
    boundActionName: name,
    registrationVersion: "1",
  };
}
