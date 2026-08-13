import { describe, expect, it } from "vitest";
import { createOperationCatalogSnapshot } from "@agent-anything/operation-catalog/catalog";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import { createToolRegistrationSnapshot, type ToolRegistrationInput } from "../registration/index.js";
import {
  createControllerToolExposureProof,
  createFixedLocalToolSelection,
  findSelectedTool,
  snapshotToolSelectionRevision,
} from "./ToolSelection.js";

describe("ToolSelection", () => {
  it("separates Controller exposure from workflow-only Tool selection", () => {
    const read = operationRevision("read-file");
    const create = operationRevision("create-file");
    const operationCatalog = createOperationCatalog([read, create]);
    const registrations = createToolRegistrationSnapshot(operationCatalog, [
      registration("codeAgent.readFile", "read-file", read),
      registration("codeAgent.createFile", "create-file", create),
    ]);
    const selection = createFixedLocalToolSelection(registrations, operationCatalog, [
      { tool: toolRevision("read-file"), origins: ["model"] },
      { tool: toolRevision("create-file"), origins: ["workflow"] },
    ]);
    const exposure = createControllerToolExposureProof(selection, "controller-request-1");

    expect(exposure.catalog.tools.map((tool) => tool.name)).toEqual([
      "codeAgent.readFile",
    ]);
    expect(exposure.exposedTools).toEqual([toolRevision("read-file")]);
    expect(findSelectedTool(selection, "codeAgent.readFile", "model")).toBeDefined();
    expect(findSelectedTool(selection, "codeAgent.createFile", "model")).toBeUndefined();
    expect(findSelectedTool(selection, toolRevision("create-file"), "workflow")).toBeDefined();
    expect(selection.selectionId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(exposure.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces deterministic immutable selection and exposure identities", () => {
    const read = operationRevision("read-file");
    const create = operationRevision("create-file");
    const operationCatalog = createOperationCatalog([read, create]);
    const registrations = createToolRegistrationSnapshot(operationCatalog, [
      registration("codeAgent.readFile", "read-file", read),
      registration("codeAgent.createFile", "create-file", create),
    ]);
    const left = createFixedLocalToolSelection(registrations, operationCatalog, [
      { tool: toolRevision("read-file"), origins: ["model", "workflow"] },
      { tool: toolRevision("create-file"), origins: ["workflow"] },
    ]);
    const right = createFixedLocalToolSelection(registrations, operationCatalog, [
      { tool: toolRevision("create-file"), origins: ["workflow"] },
      { tool: toolRevision("read-file"), origins: ["workflow", "model"] },
    ]);

    expect(left.selectionId).toBe(right.selectionId);
    expect(snapshotToolSelectionRevision(left)).toEqual(left);
    expect(Object.isFrozen(left.tools)).toBe(true);
    expect(Object.isFrozen(left.tools[0]?.origins)).toBe(true);
    expect(createControllerToolExposureProof(left, "controller-request-1").id)
      .toBe(createControllerToolExposureProof(right, "controller-request-1").id);
  });

  it("rejects unknown Tools, duplicate revisions, empty origins, and catalog mismatch", () => {
    const read = operationRevision("read-file");
    const operationCatalog = createOperationCatalog([read]);
    const registrations = createToolRegistrationSnapshot(operationCatalog, [
      registration("codeAgent.readFile", "read-file", read),
    ]);
    expect(() => createFixedLocalToolSelection(registrations, operationCatalog, [{
      tool: toolRevision("missing"),
      origins: ["model"],
    }])).toThrowError(expect.objectContaining({ code: "tool_selection_unknown" }));
    expect(() => createFixedLocalToolSelection(registrations, operationCatalog, [
      { tool: toolRevision("read-file"), origins: ["model"] },
      { tool: toolRevision("read-file"), origins: ["workflow"] },
    ])).toThrowError(expect.objectContaining({ code: "tool_selection_duplicate" }));
    expect(() => createFixedLocalToolSelection(registrations, operationCatalog, [{
      tool: toolRevision("read-file"),
      origins: [],
    }])).toThrowError(expect.objectContaining({ code: "tool_selection_origin_invalid" }));

    const otherCatalog = createOperationCatalog([read], "operation-catalog-2");
    expect(() => createFixedLocalToolSelection(registrations, otherCatalog, [{
      tool: toolRevision("read-file"),
      origins: ["model"],
    }])).toThrowError(expect.objectContaining({ code: "tool_selection_catalog_mismatch" }));
  });
});

function toolRevision(name: string) {
  return { tool: { namespace: "code-agent", name }, revision: "1" };
}

function operationRevision(name: string): OperationRevisionRef {
  return { operation: { namespace: "code", name }, revision: "1" };
}

function createOperationCatalog(
  operations: readonly OperationRevisionRef[],
  id = "operation-catalog-1",
) {
  return createOperationCatalogSnapshot({
    id,
    revision: "1",
    entries: operations.map((ref) => ({
      admissionId: `operation-admission-${ref.operation.name}`,
      operation: {
        ref,
        semanticOwner: "code-workspace",
        requestSchemaRevision: "request-1",
        resultSchemaRevision: "result-1",
        roles: {
          requestOrigins: ["tool_request", "trusted_workflow"],
          exposure: "eager_tool",
          runControl: "internal",
          trust: "effect_free",
          participation: "semantic_owner",
          domainPurpose: `code.${ref.operation.name}`,
        },
      },
      binding: {
        ref: { operation: ref, revision: "binding-1" },
        kind: "internal",
        resolverId: `resolver.${ref.operation.name}`,
        resolverRevision: "1",
      },
      sourceRevision: "source-1",
      allowedRequestOrigins: ["tool_request", "trusted_workflow"],
      admittedAt: "2026-08-13T00:00:00.000Z",
      retirement: null,
    })),
  });
}

function registration(
  name: string,
  keyName: string,
  operation: OperationRevisionRef,
): ToolRegistrationInput {
  return {
    admissionId: `tool-admission-${keyName}`,
    descriptor: {
      ref: toolRevision(keyName),
      name,
      description: `Descriptor for ${name}.`,
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
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
      operationBinding: { operation, revision: "binding-1" },
    },
    allowedOrigins: ["model", "workflow"],
    admittedAt: "2026-08-13T00:00:00.000Z",
  };
}
