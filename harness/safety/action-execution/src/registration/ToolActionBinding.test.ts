import { describe, expect, it } from "vitest";
import {
  createToolRegistrationSnapshot,
  createToolSelectionSnapshot,
} from "@agent-anything/tools";
import { createActionRegistrationSnapshot } from "./ActionRegistration.js";
import {
  assertToolActionBindingSnapshot,
  createToolActionBindingSnapshot,
  findToolActionBinding,
} from "./ToolActionBinding.js";

describe("ToolActionBinding", () => {
  it("binds a local Tool alias to one exact Action registration", () => {
    const tools = createToolRegistrationSnapshot([{
      descriptor: {
        name: "workspace.read",
        inputSchema: { type: "object", properties: {} },
      },
      source: {
        kind: "mcp",
        sourceId: "server-a",
        sourceRevision: "2026-07-28",
        activationEpoch: 4,
        capabilityId: "read_file",
      },
      schema: {
        dialect: "json-schema-2020-12",
        translationVersion: "mcp-v1",
      },
      boundActionName: "remote.invoke.read_file",
      registrationVersion: "4",
    }]);
    const selection = createToolSelectionSnapshot(tools, [{
      toolName: "workspace.read",
      origins: ["model"],
    }]);
    const actions = createActionRegistrationSnapshot([action(
      "remote.invoke.read_file",
    )]);
    const snapshot = createToolActionBindingSnapshot(selection, actions);

    expect(findToolActionBinding(snapshot, "workspace.read", "model")).toMatchObject({
      toolName: "workspace.read",
      boundActionName: "remote.invoke.read_file",
      source: {
        kind: "mcp",
        sourceId: "server-a",
        activationEpoch: 4,
      },
    });
    expect(findToolActionBinding(snapshot, "workspace.read", "workflow")).toBeUndefined();
    expect(snapshot.actionRegistrationSnapshotId).toBe(actions.snapshotId);
    expect(() => assertToolActionBindingSnapshot(snapshot)).not.toThrow();
  });

  it("fails closed when a selected Tool has no matching Action registration", () => {
    const tools = createToolRegistrationSnapshot([{
      descriptor: {
        name: "workspace.read",
        inputSchema: { type: "object", properties: {} },
      },
      source: {
        kind: "product",
        sourceId: "test",
        sourceRevision: "1",
        activationEpoch: null,
        capabilityId: "read",
      },
      schema: {
        dialect: "json-schema-2020-12",
        translationVersion: "native-v1",
      },
      boundActionName: "actions.missing",
      registrationVersion: "1",
    }]);
    const selection = createToolSelectionSnapshot(tools, [{
      toolName: "workspace.read",
      origins: ["model"],
    }]);

    expect(() => createToolActionBindingSnapshot(
      selection,
      createActionRegistrationSnapshot([]),
    )).toThrowError(expect.objectContaining({
      code: "tool_action_binding_missing",
    }));
  });
});

function action(actionName: string) {
  return {
    actionName,
    adapter: {
      id: `${actionName}.adapter`,
      version: "1",
      inputSchemaVersion: "1",
    },
    executor: {
      id: `${actionName}.executor`,
      version: "1",
      invocationContractVersion: "1",
    },
  };
}
