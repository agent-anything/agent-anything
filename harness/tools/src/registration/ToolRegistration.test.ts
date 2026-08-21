import { describe, expect, it } from "vitest";
import { createOperationCatalogSnapshot } from "@agent-anything/operation-catalog/catalog";
import type { OperationRevisionRef } from "@agent-anything/operation-catalog/identity";
import {
  createToolRegistrationSnapshot,
  findToolRegistration,
  type ToolRegistrationInput,
} from "./ToolRegistration.js";

describe("ToolRegistration", () => {
  it("retains exact immutable source, schema, Tool, and Operation binding identity", () => {
    const operation = operationRevision("read-file");
    const catalog = operationCatalog([operation]);
    const input = registration("codeAgent.readFile", "read-file", operation);
    const snapshot = createToolRegistrationSnapshot(catalog, [input]);
    (input.descriptor.inputSchema as Record<string, unknown>).properties = {};

    const registered = findToolRegistration(snapshot, "codeAgent.readFile");
    expect(registered).toMatchObject({
      admissionId: "tool-admission-read-file",
      descriptor: {
        source: {
          kind: "product",
          sourceId: "helarc-code-agent",
          sourceRevision: "1",
          activationEpoch: null,
        },
        schemaRevisions: {
          dialect: "json-schema-2020-12",
          input: "input-1",
          output: null,
          translation: "native-1",
        },
        binding: { kind: "operation", operation, revision: "binding-1" },
      },
      binding: { kind: "operation", operation: { operation: { ref: operation } } },
      allowedOrigins: ["model", "workflow"],
    });
    expect(registered?.descriptor.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(registered?.registrationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.snapshotId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(registered?.descriptor.source)).toBe(true);
  });

  it("produces the same snapshot identity for equivalent discovery order", () => {
    const read = operationRevision("read-file");
    const list = operationRevision("list-files");
    const catalog = operationCatalog([read, list]);
    const first = registration("codeAgent.readFile", "read-file", read);
    const second = registration("codeAgent.listFiles", "list-files", list);
    const left = createToolRegistrationSnapshot(catalog, [first, second]);
    const right = createToolRegistrationSnapshot(catalog, [second, first]);

    expect(left.snapshotId).toBe(right.snapshotId);
    expect(left.registrations.map((item) => item.descriptor.name)).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
    ]);
  });

  it("rejects malformed source epochs, duplicate names, and missing Operation bindings", () => {
    const read = operationRevision("read-file");
    const catalog = operationCatalog([read]);
    const first = registration("codeAgent.readFile", "read-file", read);
    const duplicateName = {
      ...first,
      admissionId: "tool-admission-read-file-2",
      descriptor: {
        ...first.descriptor,
        ref: { ...first.descriptor.ref, revision: "2" },
      },
    };
    expect(() => createToolRegistrationSnapshot(catalog, [first, duplicateName]))
      .toThrowError(expect.objectContaining({ code: "tool_name_duplicate" }));
    expect(() => createToolRegistrationSnapshot(catalog, [{
      ...first,
      descriptor: {
        ...first.descriptor,
        source: { ...first.descriptor.source, activationEpoch: 0 },
      },
    }])).toThrowError(expect.objectContaining({ code: "tool_identity_invalid" }));
    const missing = operationRevision("missing");
    expect(() => createToolRegistrationSnapshot(catalog, [
      registration("codeAgent.missing", "missing", missing),
    ])).toThrowError(expect.objectContaining({ code: "tool_operation_binding_missing" }));
  });
});

function operationRevision(name: string): OperationRevisionRef {
  return { operation: { namespace: "code", name }, revision: "1" };
}

function operationCatalog(operations: readonly OperationRevisionRef[]) {
  return createOperationCatalogSnapshot({
    id: "operation-catalog-1",
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
      ref: { tool: { namespace: "code-agent", name: keyName }, revision: "1" },
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
      binding: { kind: "operation", operation, revision: "binding-1" },
    },
    allowedOrigins: ["model", "workflow"],
    admittedAt: "2026-08-13T00:00:00.000Z",
  };
}
