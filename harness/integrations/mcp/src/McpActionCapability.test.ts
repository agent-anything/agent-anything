import type { TrustedRemoteActionRegistration } from "@agent-anything/remote-integrations/action";
import { describe, expect, it } from "vitest";
import { createMcpActionCapability } from "./createMcpActionCapability.js";
import type { McpActivationSnapshot } from "./McpLifecycle.js";

const SERVER_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const TRANSPORT_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const CLIENT_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const CAPABILITY_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const ACTIVATION_ID = `sha256:${"e".repeat(64)}`;
const NOW = "2026-08-03T04:00:00.000Z";

describe("createMcpActionCapability", () => {
  it("reuses the protocol-neutral remote enforcement adapter", () => {
    const trustedRegistration = registration();
    const active = activation();
    const capability = createMcpActionCapability({
      registration: trustedRegistration,
      activationResolver: {
        resolveActivation(input) {
          return input.registrationFingerprint === SERVER_FINGERPRINT
            ? active
            : null;
        },
      },
      operationPort: {
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
      activationResolver: {
        resolveActivation() {
          return activation();
        },
      },
      operationPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    })).toThrow("MCP Action capability requires MCP Tool source provenance.");
  });

  it("requires a current activation with exact source provenance", () => {
    expect(() => createMcpActionCapability({
      registration: registration(),
      activationResolver: {
        resolveActivation() {
          return null;
        },
      },
      operationPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    })).toThrow("requires a current validated activation");

    expect(() => createMcpActionCapability({
      registration: registration({
        source: {
          kind: "mcp",
          sourceId: "mcp_server",
          sourceRevision: "stale-registration",
          activationEpoch: 1,
          capabilityId: "status",
        },
      }),
      activationResolver: {
        resolveActivation() {
          return activation();
        },
      },
      operationPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    })).toThrow("requires exact server, registration, and activation provenance");
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
      sourceRevision: SERVER_FINGERPRINT,
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

function activation(): McpActivationSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    activationId: ACTIVATION_ID,
    serverId: "mcp_server",
    registrationFingerprint: SERVER_FINGERPRINT,
    transportBindingFingerprint: TRANSPORT_FINGERPRINT,
    activationEpoch: 1,
    displayName: "MCP Server",
    authorityBindingId: "authority-main",
    protocolRevision: "2026-07-28",
    clientProfileId: "helarc-client",
    clientProfileFingerprint: CLIENT_FINGERPRINT,
    transport: Object.freeze({
      kind: "streamable-http",
      bindingId: "binding-main",
      bindingRevision: "binding-1",
      configurationRef: "host-config:mcp-main",
      bindingFingerprint: TRANSPORT_FINGERPRINT,
    }),
    transportConnectionId: "connection-1",
    discovery: Object.freeze({
      protocolRevision: "2026-07-28",
      serverCapabilities: Object.freeze({
        schemaVersion: 1,
        snapshotId: CAPABILITY_FINGERPRINT,
        advertisedCapabilityIds: Object.freeze(["tools"]),
        capabilities: Object.freeze({
          tools: Object.freeze({}),
        }),
      }),
      selfReportedServerInfo: null,
      instructions: null,
      cache: Object.freeze({
        ttlMs: 0,
        scope: "private",
        receivedAt: NOW,
        expiresAt: NOW,
      }),
    }),
    activatedAt: NOW,
  });
}
