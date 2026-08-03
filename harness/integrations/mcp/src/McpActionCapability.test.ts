import type { TrustedRemoteActionRegistration } from "@agent-anything/remote-integrations/action";
import { describe, expect, it } from "vitest";
import { createMcpActionCapability } from "./createMcpActionCapability.js";

const SERVER_FINGERPRINT = `sha256:${"a".repeat(64)}`;

describe("createMcpActionCapability", () => {
  it("reuses the protocol-neutral remote enforcement adapter", () => {
    const capability = createMcpActionCapability({
      registration: registration(),
      connectionPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    });

    expect(capability.adapters[0]?.adapter.descriptor.id).toBe(
      "remote-integrations.remote-action.adapter",
    );
    expect(capability.executors[0]?.descriptor.id).toBe(
      "remote-integrations.remote-action.executor",
    );
    expect(capability.toolRegistrations.registrations[0]).toMatchObject({
      descriptor: { name: "mcp.status" },
      source: { kind: "mcp", sourceId: "mcp_server" },
      boundActionName: "remote.invoke.mcp.status",
    });
  });

  it("rejects non-MCP source provenance", () => {
    const remote = registration({
      source: {
        kind: "remote",
        sourceId: "remote_node",
        sourceRevision: "1",
        activationEpoch: 1,
        capabilityId: "status",
      },
    });

    expect(() => createMcpActionCapability({
      registration: remote,
      connectionPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    })).toThrow("MCP Action capability requires MCP Tool source provenance.");
  });
});

function registration(
  overrides: Partial<TrustedRemoteActionRegistration> = {},
): TrustedRemoteActionRegistration {
  return {
    localToolName: "mcp.status",
    actionName: "remote.invoke.mcp.status",
    source: {
      kind: "mcp",
      sourceId: "mcp_server",
      sourceRevision: "1",
      activationEpoch: 1,
      capabilityId: "status",
    },
    sourceDisplayName: "MCP Server",
    server: {
      serverId: "mcp_server",
      registrationFingerprint: SERVER_FINGERPRINT,
      transport: "http",
      endpoint: {
        transport: "tcp",
        host: "127.0.0.1",
        port: 8080,
        applicationProtocol: "http",
      },
    },
    serverDisplayName: "MCP Server",
    toolName: "status",
    toolDisplayName: "Status",
    inputSchema: { type: "object" },
    schema: {
      dialect: "json-schema-2020-12",
      translationVersion: "native-v1",
    },
    registrationVersion: "1",
    supportsSessionAuthority: true,
    timeoutMs: 1_000,
    ...overrides,
  };
}
