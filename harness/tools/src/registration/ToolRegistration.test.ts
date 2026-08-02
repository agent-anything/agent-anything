import { describe, expect, it } from "vitest";
import {
  createToolRegistrationSnapshot,
  findToolRegistration,
  type ToolRegistrationInput,
} from "./ToolRegistration.js";

describe("ToolRegistration", () => {
  it("retains immutable source, schema, descriptor, and Action binding identity", () => {
    const input = registration("codeAgent.readFile", "actions.read");
    const snapshot = createToolRegistrationSnapshot([input]);
    input.descriptor.inputSchema.properties = {};

    const registered = findToolRegistration(snapshot, "codeAgent.readFile");
    expect(registered).toMatchObject({
      source: {
        kind: "product",
        sourceId: "helarc-code-agent",
        sourceRevision: "1",
        activationEpoch: null,
        capabilityId: "read-file",
      },
      schema: {
        dialect: "json-schema-2020-12",
        translationVersion: "native-v1",
      },
      boundActionName: "actions.read",
      registrationVersion: "1",
    });
    expect(registered?.descriptorFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(registered?.registrationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.snapshotId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(registered?.source)).toBe(true);
  });

  it("produces the same snapshot identity for equivalent discovery order", () => {
    const first = registration("codeAgent.readFile", "actions.read");
    const second = registration("codeAgent.listFiles", "actions.list");
    const left = createToolRegistrationSnapshot([first, second]);
    const right = createToolRegistrationSnapshot([second, first]);

    expect(left.snapshotId).toBe(right.snapshotId);
    expect(left.registrations.map((item) => item.descriptor.name)).toEqual([
      "codeAgent.listFiles",
      "codeAgent.readFile",
    ]);
  });

  it("rejects malformed source epochs and duplicate local names", () => {
    expect(() => createToolRegistrationSnapshot([
      registration("codeAgent.readFile", "actions.read"),
      registration("codeAgent.readFile", "actions.other"),
    ])).toThrowError(expect.objectContaining({ code: "tool_name_duplicate" }));

    expect(() => createToolRegistrationSnapshot([{
      ...registration("codeAgent.readFile", "actions.read"),
      source: {
        ...registration("codeAgent.readFile", "actions.read").source,
        activationEpoch: 0,
      },
    }])).toThrowError(expect.objectContaining({ code: "tool_source_invalid" }));
  });
});

function registration(
  name: string,
  boundActionName: string,
): ToolRegistrationInput {
  return {
    descriptor: {
      name,
      description: `Descriptor for ${name}.`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
    source: {
      kind: "product",
      sourceId: "helarc-code-agent",
      sourceRevision: "1",
      activationEpoch: null,
      capabilityId: name.endsWith("readFile") ? "read-file" : "list-files",
    },
    schema: {
      dialect: "json-schema-2020-12",
      translationVersion: "native-v1",
    },
    boundActionName,
    registrationVersion: "1",
  };
}
