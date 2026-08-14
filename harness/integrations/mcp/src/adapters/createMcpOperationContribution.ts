import type {
  RemoteOperationContribution,
  RemoteOperationRegistrationResolver,
  TrustedRemoteOperationRegistration,
} from "@agent-anything/remote-integrations/operation";
import { createRemoteOperationContribution } from "@agent-anything/remote-integrations/operation";
import {
  createMcpContractFingerprint,
  snapshotMcpJsonObject,
} from "../protocol/McpJson.js";
import type {
  McpSourceLookup,
  McpSourceResolver,
  McpSourceSnapshot,
  McpToolDescriptor,
} from "../primitives/McpPrimitives.js";
import type { McpToolOperationPort } from "../primitives/McpToolOperationPort.js";

export interface CreateMcpOperationContributionInput {
  readonly registration: TrustedRemoteOperationRegistration;
  readonly registrationResolver?: RemoteOperationRegistrationResolver;
  readonly sourceResolver: McpSourceResolver;
  readonly operationPort: McpToolOperationPort;
  readonly now?: () => string;
}

interface McpOperationBinding {
  readonly source: McpSourceLookup;
  readonly remoteOperationName: string;
  readonly toolDescriptorFingerprint: string;
}

export function createMcpOperationContribution(
  input: CreateMcpOperationContributionInput,
): RemoteOperationContribution {
  if (input.registration.source.kind !== "mcp") {
    throw new TypeError("MCP Operation contribution requires MCP source provenance.");
  }
  if (input.registration.localTool === null) {
    throw new TypeError("MCP Tool adaptation requires an admitted local Tool descriptor.");
  }
  const binding = bindCurrentSource(input.registration, input.sourceResolver);
  return createRemoteOperationContribution({
    registration: input.registration,
    registrationResolver: input.registrationResolver,
    now: input.now,
    transport: {
      async invoke(invocation) {
        try {
          const source = sourceLookup(invocation);
          if (!sameSource(source, binding.source)) {
            return failed("tool_mcp_source_stale", "MCP source epoch is stale.", "none");
          }
          const current = input.sourceResolver.resolveSource(source);
          const tool = current === null
            ? null
            : findTool(current, invocation.remoteOperationName);
          if (
            current === null ||
            !sameSource(current, source) ||
            tool === null ||
            tool.descriptorFingerprint !== binding.toolDescriptorFingerprint ||
            invocation.remoteOperationName !== binding.remoteOperationName
          ) {
            return failed(
              "tool_mcp_source_stale",
              "MCP source or Tool registration is unavailable or stale.",
              "none",
            );
          }
          const result = await input.operationPort.callTool({
            source,
            toolName: invocation.remoteOperationName,
            toolCallId: invocation.actionId,
            input: invocation.input,
            signal: invocation.signal,
          });
          if (
            result.toolCallId !== invocation.actionId ||
            result.toolName !== invocation.remoteOperationName
          ) {
            return failed(
              "tool_mcp_result_mismatch",
              "MCP result did not match the dispatched remote invocation.",
              "unknown",
            );
          }
          const metadata = Object.freeze({
            ...result.metadata,
            remoteSourceKind: invocation.sourceKind,
            remoteSourceId: invocation.sourceId,
            mcpServerId: invocation.serverId,
            mcpToolName: invocation.remoteOperationName,
            mcpRegistrationFingerprint: current.registrationFingerprint,
            mcpTransportBindingFingerprint:
              current.transportActivation.transportBindingFingerprint,
            mcpTransportActivationGeneration:
              current.transportActivation.activationGeneration,
            mcpSourceEpoch: current.sourceEpoch,
            mcpToolDescriptorFingerprint: tool.descriptorFingerprint,
          });
          return Object.freeze({
            status: "completed" as const,
            output: result.output,
            semanticError: result.isError
              ? Object.freeze({
                  code: "tool_mcp_reported_error",
                  message: "The MCP server reported that the Operation failed.",
                  metadata: {},
                })
              : null,
            metadata,
          });
        } catch (error) {
          if (invocation.signal.aborted) {
            return Object.freeze({
              status: "interrupted" as const,
              effectState: "unknown" as const,
              evidence: Object.freeze({
                code: "tool_mcp_interrupted",
                message: "MCP Tool invocation was interrupted after dispatch.",
                metadata: {},
              }),
            });
          }
          return failed(
            "tool_mcp_call_failed",
            error instanceof Error ? error.message : "MCP Tool call failed.",
            "unknown",
          );
        }
      },
    },
  });
}

function bindCurrentSource(
  registration: TrustedRemoteOperationRegistration,
  resolver: McpSourceResolver,
): McpOperationBinding {
  const source = sourceLookup(registration);
  const snapshot = resolver.resolveSource(source);
  if (snapshot === null || !sameSource(snapshot, source)) {
    throw new TypeError(
      "MCP Operation contribution requires a current validated source snapshot.",
    );
  }
  const tool = findTool(snapshot, registration.remoteOperationName);
  if (tool === null || !matchesRegistration(registration, snapshot, tool)) {
    throw new TypeError(
      "MCP Operation contribution requires exact source and Tool registration provenance.",
    );
  }
  return Object.freeze({
    source,
    remoteOperationName: tool.name,
    toolDescriptorFingerprint: tool.descriptorFingerprint,
  });
}

function sourceLookup(input: {
  readonly sourceKind?: "mcp" | "plugin" | "remote";
  readonly sourceId?: string;
  readonly serverId?: string;
  readonly source?: TrustedRemoteOperationRegistration["source"];
  readonly server?: TrustedRemoteOperationRegistration["server"];
}): McpSourceLookup {
  const sourceId = input.sourceId ?? input.source?.sourceId;
  const serverId = input.serverId ?? input.server?.serverId;
  const sourceRevision = input.source?.sourceRevision;
  const sourceEpoch = input.source?.activationEpoch;
  const registrationFingerprint = sourceRevision ?? input.server?.registrationFingerprint;
  if (
    sourceId === undefined ||
    serverId === undefined ||
    sourceId !== serverId ||
    registrationFingerprint === undefined ||
    registrationFingerprint === null ||
    (input.server !== undefined && registrationFingerprint !== input.server.registrationFingerprint) ||
    sourceEpoch === undefined ||
    sourceEpoch === null
  ) {
    throw new TypeError(
      "MCP Operation contribution requires exact server, registration, and source-epoch provenance.",
    );
  }
  return Object.freeze({
    serverId,
    registrationFingerprint,
    sourceEpoch,
  });
}

function matchesRegistration(
  registration: TrustedRemoteOperationRegistration,
  snapshot: McpSourceSnapshot,
  tool: McpToolDescriptor,
): boolean {
  const localTool = registration.localTool;
  if (
    localTool === null ||
    registration.server.serverId !== snapshot.serverId ||
    registration.server.registrationFingerprint !== snapshot.registrationFingerprint ||
    registration.source.capabilityId !== tool.name ||
    registration.remoteOperationName !== tool.name ||
    localTool.schemaRevisions.dialect !== tool.schema.dialect ||
    localTool.schemaRevisions.translation !== tool.schema.translationVersion ||
    registration.server.transport !== expectedRemoteTransport(snapshot)
  ) return false;

  const inputSchema = snapshotMcpJsonObject(
    localTool.inputSchema,
    "registration.localTool.inputSchema",
  );
  return createMcpContractFingerprint(
    "agent-anything.mcp-json-schema.v1",
    Object.freeze({ dialect: tool.schema.dialect, schema: inputSchema }),
  ) === tool.inputSchemaFingerprint;
}

function expectedRemoteTransport(
  snapshot: McpSourceSnapshot,
): TrustedRemoteOperationRegistration["server"]["transport"] {
  return snapshot.transportActivation.transport.kind === "streamable-http"
    ? "http"
    : "stdio";
}

function findTool(
  snapshot: McpSourceSnapshot,
  toolName: string,
): McpToolDescriptor | null {
  return snapshot.tools.items.find((candidate) => candidate.name === toolName) ?? null;
}

function sameSource(
  left: McpSourceLookup,
  right: McpSourceLookup,
): boolean {
  return left.serverId === right.serverId &&
    left.registrationFingerprint === right.registrationFingerprint &&
    left.sourceEpoch === right.sourceEpoch;
}

function failed(
  code: string,
  message: string,
  effectState: "none" | "settled" | "unknown",
) {
  return Object.freeze({
    status: "failed" as const,
    effectState,
    failure: Object.freeze({
      code,
      message,
      retryable: false,
      metadata: {},
    }),
  });
}
