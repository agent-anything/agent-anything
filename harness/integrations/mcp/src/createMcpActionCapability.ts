import type {
  RemoteActionCapability,
  RemoteActionRegistrationResolver,
  TrustedRemoteActionRegistration,
} from "@agent-anything/remote-integrations/action";
import { createRemoteActionCapability } from "@agent-anything/remote-integrations/action";
import {
  createMcpContractFingerprint,
  snapshotMcpJsonObject,
} from "./McpJson.js";
import type {
  McpSourceLookup,
  McpSourceResolver,
  McpSourceSnapshot,
  McpToolDescriptor,
} from "./McpPrimitives.js";
import type { McpToolOperationPort } from "./McpToolOperationPort.js";

export interface CreateMcpActionCapabilityInput {
  readonly registration: TrustedRemoteActionRegistration;
  readonly registrationResolver?: RemoteActionRegistrationResolver;
  readonly sourceResolver: McpSourceResolver;
  readonly operationPort: McpToolOperationPort;
  readonly now?: () => string;
}

interface McpActionBinding {
  readonly source: McpSourceLookup;
  readonly toolName: string;
  readonly toolDescriptorFingerprint: string;
}

export function createMcpActionCapability(
  input: CreateMcpActionCapabilityInput,
): RemoteActionCapability {
  if (input.registration.source.kind !== "mcp") {
    throw new TypeError("MCP Action capability requires MCP Tool source provenance.");
  }
  const binding = bindCurrentSource(input.registration, input.sourceResolver);
  const now = input.now ?? (() => new Date().toISOString());
  return createRemoteActionCapability({
    registration: input.registration,
    registrationResolver: input.registrationResolver,
    now,
    invokePort: {
      async invoke(invocation) {
        const startedAt = now();
        try {
          const source = sourceLookup(invocation);
          if (!sameSource(source, binding.source)) {
            throw codedError(
              "tool_mcp_source_stale",
              "MCP invocation does not identify the registered source epoch.",
            );
          }
          const current = input.sourceResolver.resolveSource(source);
          const tool = current === null
            ? null
            : findTool(current, invocation.toolName);
          if (
            current === null ||
            !sameSource(current, source) ||
            tool === null ||
            tool.descriptorFingerprint !== binding.toolDescriptorFingerprint ||
            invocation.toolName !== binding.toolName
          ) {
            throw codedError(
              "tool_mcp_source_stale",
              "MCP source or Tool registration is unavailable or stale.",
            );
          }
          const result = await input.operationPort.callTool({
            source,
            toolName: invocation.toolName,
            toolCallId: invocation.actionId,
            input: invocation.input,
            signal: invocation.signal,
          });
          if (
            result.toolCallId !== invocation.actionId ||
            result.toolName !== invocation.toolName
          ) {
            throw codedError(
              "tool_mcp_result_mismatch",
              "MCP result did not match the authorized remote invocation.",
            );
          }
          const metadata = {
            ...result.metadata,
            remoteSourceKind: invocation.source.kind,
            remoteSourceId: invocation.source.sourceId,
            remoteSourceCapabilityId: invocation.source.capabilityId,
            mcpServerId: invocation.serverId,
            mcpToolName: invocation.toolName,
            mcpRegistrationFingerprint: current.registrationFingerprint,
            mcpTransportBindingFingerprint:
              current.transportActivation.transportBindingFingerprint,
            mcpTransportActivationGeneration:
              current.transportActivation.activationGeneration,
            mcpSourceEpoch: current.sourceEpoch,
            mcpToolDescriptorFingerprint: tool.descriptorFingerprint,
          };
          if (result.isError) {
            return {
              toolCallId: invocation.actionId,
              toolName: invocation.actionName,
              status: "failed" as const,
              error: {
                code: "tool_mcp_reported_error",
                message: "The MCP server reported that the Tool call failed.",
              },
              startedAt,
              finishedAt: now(),
              metadata,
            };
          }
          return {
            toolCallId: invocation.actionId,
            toolName: invocation.actionName,
            status: "succeeded" as const,
            output: result.output,
            startedAt,
            finishedAt: now(),
            metadata,
          };
        } catch (error) {
          if (hasCode(error)) throw error;
          throw codedError("tool_mcp_call_failed", "MCP Tool call failed.");
        }
      },
    },
  });
}

function bindCurrentSource(
  registration: TrustedRemoteActionRegistration,
  resolver: McpSourceResolver,
): McpActionBinding {
  const source = sourceLookup(registration);
  const snapshot = resolver.resolveSource(source);
  if (snapshot === null || !sameSource(snapshot, source)) {
    throw new TypeError(
      "MCP Action capability requires a current validated source snapshot.",
    );
  }
  const tool = findTool(snapshot, registration.toolName);
  if (tool === null || !matchesRegistration(registration, snapshot, tool)) {
    throw new TypeError(
      "MCP Action capability requires exact source and Tool registration provenance.",
    );
  }
  return Object.freeze({
    source,
    toolName: tool.name,
    toolDescriptorFingerprint: tool.descriptorFingerprint,
  });
}

function sourceLookup(input: {
  readonly source: TrustedRemoteActionRegistration["source"];
  readonly serverId?: string;
  readonly server?: TrustedRemoteActionRegistration["server"];
}): McpSourceLookup {
  const serverId = input.serverId ?? input.server?.serverId;
  const sourceRevision = input.source.sourceRevision;
  const sourceEpoch = input.source.activationEpoch;
  if (
    serverId === undefined ||
    input.source.sourceId !== serverId ||
    sourceRevision === null ||
    (
      input.server !== undefined &&
      sourceRevision !== input.server.registrationFingerprint
    ) ||
    sourceEpoch === null
  ) {
    throw new TypeError(
      "MCP Action capability requires exact server, registration, and source-epoch provenance.",
    );
  }
  return Object.freeze({
    serverId,
    registrationFingerprint: sourceRevision,
    sourceEpoch,
  });
}

function matchesRegistration(
  registration: TrustedRemoteActionRegistration,
  snapshot: McpSourceSnapshot,
  tool: McpToolDescriptor,
): boolean {
  if (
    registration.server.serverId !== snapshot.serverId ||
    registration.server.registrationFingerprint !==
      snapshot.registrationFingerprint ||
    registration.source.capabilityId !== tool.name ||
    registration.toolName !== tool.name ||
    registration.schema.dialect !== tool.schema.dialect ||
    registration.schema.translationVersion !== tool.schema.translationVersion ||
    registration.server.transport !== expectedRemoteTransport(snapshot)
  ) {
    return false;
  }
  const inputSchema = snapshotMcpJsonObject(
    registration.inputSchema,
    "registration.inputSchema",
  );
  const inputSchemaFingerprint = createMcpContractFingerprint(
    "agent-anything.mcp-json-schema.v1",
    Object.freeze({
      dialect: tool.schema.dialect,
      schema: inputSchema,
    }),
  );
  return inputSchemaFingerprint === tool.inputSchemaFingerprint;
}

function expectedRemoteTransport(
  snapshot: McpSourceSnapshot,
): TrustedRemoteActionRegistration["server"]["transport"] {
  return snapshot.transportActivation.transport.kind === "streamable-http"
    ? "http"
    : "stdio";
}

function findTool(
  snapshot: McpSourceSnapshot,
  toolName: string,
): McpToolDescriptor | null {
  return snapshot.tools.items.find((candidate) => candidate.name === toolName) ??
    null;
}

function sameSource(
  left: McpSourceLookup,
  right: McpSourceLookup,
): boolean {
  return left.serverId === right.serverId &&
    left.registrationFingerprint === right.registrationFingerprint &&
    left.sourceEpoch === right.sourceEpoch;
}

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function hasCode(error: unknown): error is { readonly code: string } {
  return error !== null && typeof error === "object" &&
    "code" in error && typeof (error as { code?: unknown }).code === "string";
}
