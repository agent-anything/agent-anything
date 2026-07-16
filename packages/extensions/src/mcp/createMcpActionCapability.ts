import type {
  RemoteActionCapability,
  RemoteActionRegistrationResolver,
  TrustedRemoteActionRegistration,
} from "../action-registrations/index.js";
import { createRemoteActionCapability } from "../action-registrations/index.js";
import type { McpConnectionPort } from "./McpConnectionPort.js";

export interface CreateMcpActionCapabilityInput {
  readonly registration: TrustedRemoteActionRegistration;
  readonly registrationResolver?: RemoteActionRegistrationResolver;
  readonly connectionPort: McpConnectionPort;
  readonly now?: () => string;
}

export function createMcpActionCapability(
  input: CreateMcpActionCapabilityInput,
): RemoteActionCapability {
  const now = input.now ?? (() => new Date().toISOString());
  return createRemoteActionCapability({
    registration: input.registration,
    registrationResolver: input.registrationResolver,
    now,
    invokePort: {
      async invoke(invocation) {
        const startedAt = now();
        try {
          const result = await input.connectionPort.callTool({
            serverId: invocation.serverId,
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
          return {
            toolCallId: invocation.actionId,
            toolName: invocation.actionName,
            status: "succeeded" as const,
            output: result.output,
            error: null,
            startedAt,
            finishedAt: now(),
            metadata: {
              ...result.metadata,
              mcpServerId: invocation.serverId,
              mcpToolName: invocation.toolName,
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

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function hasCode(error: unknown): error is { readonly code: string } {
  return error !== null && typeof error === "object" &&
    "code" in error && typeof (error as { code?: unknown }).code === "string";
}
