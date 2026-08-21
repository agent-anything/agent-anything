import type { TrustedRemoteOperationRegistration } from "@agent-anything/remote-integrations/operation";
import { describe, expect, it } from "vitest";
import { createMcpOperationContribution } from "./createMcpOperationContribution.js";
import { createMcpContractFingerprint } from "../protocol/McpJson.js";
import type { McpSourceSnapshot } from "../primitives/McpPrimitives.js";
import {
  MCP_JSON_SCHEMA_2020_12,
  MCP_SCHEMA_TRANSLATION_VERSION,
} from "../protocol/McpSchema.js";

const SERVER_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-03T04:00:00.000Z";

describe("createMcpOperationContribution", () => {
  it("adapts one admitted MCP Tool through a hosted Operation and canonical Action", () => {
    const source = sourceSnapshot();
    const contribution = createMcpOperationContribution({
      registration: registration(),
      sourceResolver: { resolveSource: () => source },
      operationPort: { async callTool() { throw new Error("not executed"); } },
    });

    expect(contribution.operations[0]).toMatchObject({
      operation: {
        ref: { operation: { namespace: "mcp.mcp_server", name: "status" } },
        roles: { runControl: "hosted", trust: "remote_hosted_trust_edge" },
      },
      binding: { kind: "hosted" },
    });
    expect(contribution.tools[0]).toMatchObject({
      descriptor: {
        name: "mcp.status",
        binding: {
          kind: "operation",
          operation: { operation: { name: "status" } },
        },
      },
    });
    expect(contribution.actionRegistrations.registrations[0]?.effectFamilies)
      .toEqual(["network", "remote_invocation"]);
    expect(contribution.adapters[0]?.adapter.descriptor.id)
      .toContain("remote.mcp.mcp_server.mcp_server.status");
  });

  it("rejects non-MCP source provenance", () => {
    expect(() => createMcpOperationContribution({
      registration: registration({
        source: {
          kind: "remote",
          sourceId: "mcp_server",
          sourceRevision: SERVER_FINGERPRINT,
          activationEpoch: 1,
          capabilityId: "status",
        },
      }),
      sourceResolver: { resolveSource: () => sourceSnapshot() },
      operationPort: { async callTool() { throw new Error("not executed"); } },
    })).toThrow("requires MCP source provenance");
  });

  it("requires the exact current source epoch and Tool descriptor", () => {
    expect(() => createMcpOperationContribution({
      registration: registration(),
      sourceResolver: { resolveSource: () => null },
      operationPort: { async callTool() { throw new Error("not executed"); } },
    })).toThrow("current validated source snapshot");

    expect(() => createMcpOperationContribution({
      registration: registration({
        source: {
          kind: "mcp",
          sourceId: "mcp_server",
          sourceRevision: "stale-registration",
          activationEpoch: 1,
          capabilityId: "status",
        },
      }),
      sourceResolver: { resolveSource: () => sourceSnapshot() },
      operationPort: { async callTool() { throw new Error("not executed"); } },
    })).toThrow("exact server, registration, and source-epoch provenance");
  });
});

function registration(
  overrides: Partial<TrustedRemoteOperationRegistration> = {},
): TrustedRemoteOperationRegistration {
  const operation = Object.freeze({
    operation: Object.freeze({ namespace: "mcp.mcp_server", name: "status" }),
    revision: "1",
  });
  return {
    operation,
    binding: { operation, revision: "1" },
    bindingKind: "hosted",
    hostedEndpointRef: "mcp:mcp_server",
    semanticOwner: "mcp.mcp_server.status",
    allowedRequestOrigins: ["tool_request"],
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
    remoteOperationName: "status",
    remoteOperationDisplayName: "Status",
    localTool: {
      ref: { tool: { namespace: "mcp.mcp_server", name: "status" }, revision: "1" },
      name: "mcp.status",
      description: "Read server status.",
      inputSchema: { type: "object" },
      schemaRevisions: {
        dialect: MCP_JSON_SCHEMA_2020_12,
        input: "1",
        output: null,
        translation: MCP_SCHEMA_TRANSLATION_VERSION,
      },
      annotations: { readOnlyHint: true },
      allowedOrigins: ["model"],
    },
    registrationRevision: "1",
    admittedAt: NOW,
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
  const descriptor = Object.freeze({
    name: "status",
    schema,
    inputSchemaFingerprint: createMcpContractFingerprint(
      "agent-anything.mcp-json-schema.v1",
      Object.freeze({ dialect: schema.dialect, schema: inputSchema }),
    ),
    descriptorFingerprint: `sha256:${"f".repeat(64)}`,
  });
  return {
    serverId: "mcp_server",
    registrationFingerprint: SERVER_FINGERPRINT,
    sourceEpoch: 1,
    transportActivation: {
      transportBindingFingerprint: `sha256:${"b".repeat(64)}`,
      activationGeneration: 1,
      transport: { kind: "streamable-http" },
    },
    tools: { items: [descriptor] },
  } as unknown as McpSourceSnapshot;
}
