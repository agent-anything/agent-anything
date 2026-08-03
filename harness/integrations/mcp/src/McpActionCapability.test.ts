import type { TrustedRemoteActionRegistration } from "@agent-anything/remote-integrations/action";
import { describe, expect, it } from "vitest";
import { createMcpActionCapability } from "./createMcpActionCapability.js";
import { createMcpContractFingerprint } from "./McpJson.js";
import type { McpActivationSnapshot } from "./McpLifecycle.js";
import type { McpSourceSnapshot } from "./McpPrimitives.js";
import {
  MCP_JSON_SCHEMA_2020_12,
  MCP_SCHEMA_TRANSLATION_VERSION,
} from "./McpSchema.js";

const SERVER_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const TRANSPORT_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const CLIENT_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const CAPABILITY_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const ACTIVATION_ID = `sha256:${"e".repeat(64)}`;
const NOW = "2026-08-03T04:00:00.000Z";

describe("createMcpActionCapability", () => {
  it("reuses the protocol-neutral remote enforcement adapter", () => {
    const trustedRegistration = registration();
    const source = sourceSnapshot();
    const capability = createMcpActionCapability({
      registration: trustedRegistration,
      sourceResolver: {
        resolveSource(input) {
          return input.registrationFingerprint === SERVER_FINGERPRINT
            ? source
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
      sourceResolver: {
        resolveSource() {
          return sourceSnapshot();
        },
      },
      operationPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    })).toThrow("MCP Action capability requires MCP Tool source provenance.");
  });

  it("requires a current source epoch with exact Tool provenance", () => {
    expect(() => createMcpActionCapability({
      registration: registration(),
      sourceResolver: {
        resolveSource() {
          return null;
        },
      },
      operationPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    })).toThrow("requires a current validated source snapshot");

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
      sourceResolver: {
        resolveSource() {
          return sourceSnapshot();
        },
      },
      operationPort: {
        async callTool() {
          throw new Error("not executed");
        },
      },
    })).toThrow(
      "requires exact server, registration, and source-epoch provenance",
    );
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
      dialect: MCP_JSON_SCHEMA_2020_12,
      translationVersion: MCP_SCHEMA_TRANSLATION_VERSION,
    },
    registrationVersion: "1",
    supportsSessionAuthority: true,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function sourceSnapshot(): McpSourceSnapshot {
  const inputSchema = Object.freeze({ type: "object" as const });
  const schema = Object.freeze({
    dialect: MCP_JSON_SCHEMA_2020_12,
    translationVersion: MCP_SCHEMA_TRANSLATION_VERSION,
  });
  const inputSchemaFingerprint = createMcpContractFingerprint(
    "agent-anything.mcp-json-schema.v1",
    Object.freeze({
      dialect: schema.dialect,
      schema: inputSchema,
    }),
  );
  const descriptor = Object.freeze({
    name: "status",
    title: "Status",
    description: "Read server status.",
    icons: Object.freeze([]),
    inputSchema,
    schema,
    inputSchemaFingerprint,
    outputSchemaFingerprint: null,
    annotations: Object.freeze({}),
    headerBindings: Object.freeze([]),
    sourceMetadata: Object.freeze({}),
    descriptorFingerprint: `sha256:${"f".repeat(64)}`,
  });
  const cache = Object.freeze({
    ttlMs: 5_000,
    scope: "private" as const,
    receivedAt: NOW,
    expiresAt: "2026-08-03T04:00:05.000Z",
  });
  const unsupported = Object.freeze({
    advertised: false,
    snapshotId: `sha256:${"1".repeat(64)}`,
    items: Object.freeze([]),
    cache: null,
  });
  return Object.freeze({
    schemaVersion: 1,
    sourceSnapshotId: `sha256:${"2".repeat(64)}`,
    serverId: "mcp_server",
    registrationFingerprint: SERVER_FINGERPRINT,
    sourceEpoch: 1,
    authorityBindingId: "authority-main",
    protocolRevision: "2026-07-28",
    transportActivation: activation(),
    tools: Object.freeze({
      advertised: true,
      snapshotId: `sha256:${"3".repeat(64)}`,
      items: Object.freeze([descriptor]),
      cache,
    }),
    resources: unsupported,
    resourceTemplates: unsupported,
    prompts: unsupported,
    diagnostics: Object.freeze([]),
    publishedAt: NOW,
  });
}

function activation(): McpActivationSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    activationId: ACTIVATION_ID,
    serverId: "mcp_server",
    registrationFingerprint: SERVER_FINGERPRINT,
    transportBindingFingerprint: TRANSPORT_FINGERPRINT,
    activationGeneration: 1,
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
        ttlMs: 5_000,
        scope: "private",
        receivedAt: NOW,
        expiresAt: "2026-08-03T04:00:05.000Z",
      }),
    }),
    activatedAt: NOW,
  });
}
