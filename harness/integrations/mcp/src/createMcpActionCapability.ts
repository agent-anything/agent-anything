import type {
  RemoteActionCapability,
  RemoteActionRegistrationResolver,
  TrustedRemoteActionRegistration,
} from "@agent-anything/remote-integrations/action";
import { createRemoteActionCapability } from "@agent-anything/remote-integrations/action";
import type { McpActivationResolver } from "./McpLifecycle.js";
import type {
  McpActivationLookup,
  McpActivationSnapshot,
} from "./McpLifecycle.js";
import type { McpToolOperationPort } from "./McpToolOperationPort.js";

export interface CreateMcpActionCapabilityInput {
  readonly registration: TrustedRemoteActionRegistration;
  readonly registrationResolver?: RemoteActionRegistrationResolver;
  readonly activationResolver: McpActivationResolver;
  readonly operationPort: McpToolOperationPort;
  readonly now?: () => string;
}

export function createMcpActionCapability(
  input: CreateMcpActionCapabilityInput,
): RemoteActionCapability {
  if (input.registration.source.kind !== "mcp") {
    throw new TypeError("MCP Action capability requires MCP Tool source provenance.");
  }
  const initialLookup = activationLookup(input.registration);
  const initialActivation = input.activationResolver.resolveActivation(
    initialLookup,
  );
  if (
    initialActivation === null ||
    !matchesActivation(initialActivation, initialLookup)
  ) {
    throw new TypeError(
      "MCP Action capability requires a current validated activation.",
    );
  }
  const now = input.now ?? (() => new Date().toISOString());
  return createRemoteActionCapability({
    registration: input.registration,
    registrationResolver: input.registrationResolver,
    now,
    invokePort: {
      async invoke(invocation) {
        const startedAt = now();
        try {
          const sourceRevision = invocation.source.sourceRevision;
          const activationEpoch = invocation.source.activationEpoch;
          if (sourceRevision === null || activationEpoch === null) {
            throw codedError(
              "tool_mcp_activation_invalid",
              "MCP invocation does not identify an activation epoch.",
            );
          }
          const lookup = {
            serverId: invocation.serverId,
            registrationFingerprint: sourceRevision,
            activationEpoch,
          };
          const activation = input.activationResolver.resolveActivation(lookup);
          if (
            activation === null ||
            !matchesActivation(activation, lookup) ||
            activation.registrationFingerprint !==
              input.registration.server.registrationFingerprint
          ) {
            throw codedError(
              "tool_mcp_activation_stale",
              "MCP activation is unavailable or stale.",
            );
          }
          const result = await input.operationPort.callTool({
            activation,
            toolName: invocation.toolName,
            toolCallId: invocation.actionId,
            input: invocation.input,
            timeoutMs: invocation.timeoutMs,
            metadata: {},
          });
          if (result.toolCallId !== invocation.actionId || result.toolName !== invocation.toolName) {
            throw codedError(
              "tool_mcp_result_mismatch",
              "MCP result did not match the authorized remote invocation.",
            );
          }
          if (result.output === null || result.output === undefined) {
            throw codedError(
              "tool_mcp_result_invalid",
              "MCP result did not contain a valid output.",
            );
          }
          return {
            toolCallId: invocation.actionId,
            toolName: invocation.actionName,
            status: "succeeded" as const,
            output: result.output,
            startedAt,
            finishedAt: now(),
            metadata: {
              ...result.metadata,
              remoteSourceKind: invocation.source.kind,
              remoteSourceId: invocation.source.sourceId,
              remoteSourceCapabilityId: invocation.source.capabilityId,
              mcpServerId: invocation.serverId,
              mcpToolName: invocation.toolName,
              mcpRegistrationFingerprint:
                activation.registrationFingerprint,
              mcpTransportBindingFingerprint:
                activation.transportBindingFingerprint,
              mcpActivationEpoch: activation.activationEpoch,
            },
          };
        } catch (error) {
          if (hasCode(error)) throw error;
          throw codedError("tool_mcp_call_failed", "MCP tool call failed.");
        }
      },
    },
  });
}

function activationLookup(
  registration: TrustedRemoteActionRegistration,
): McpActivationLookup {
  const sourceRevision = registration.source.sourceRevision;
  const activationEpoch = registration.source.activationEpoch;
  if (
    registration.source.sourceId !== registration.server.serverId ||
    sourceRevision === null ||
    sourceRevision !== registration.server.registrationFingerprint ||
    activationEpoch === null
  ) {
    throw new TypeError(
      "MCP Action capability requires exact server, registration, and activation provenance.",
    );
  }
  return Object.freeze({
    serverId: registration.server.serverId,
    registrationFingerprint: sourceRevision,
    activationEpoch,
  });
}

function matchesActivation(
  activation: McpActivationSnapshot,
  lookup: McpActivationLookup,
): boolean {
  return activation.serverId === lookup.serverId &&
    activation.registrationFingerprint === lookup.registrationFingerprint &&
    activation.activationEpoch === lookup.activationEpoch;
}

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function hasCode(error: unknown): error is { readonly code: string } {
  return error !== null && typeof error === "object" &&
    "code" in error && typeof (error as { code?: unknown }).code === "string";
}
