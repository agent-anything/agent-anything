import type {
  RemoteActionCapability,
  RemoteActionRegistrationResolver,
  TrustedRemoteActionRegistration,
} from "../action-registrations/index.js";
import { createRemoteActionCapability } from "../action-registrations/index.js";
import type { RemoteToolPort } from "./RemoteToolPort.js";

export interface CreateRemoteToolActionCapabilityInput {
  readonly registration: TrustedRemoteActionRegistration;
  readonly registrationResolver?: RemoteActionRegistrationResolver;
  readonly remoteToolPort: RemoteToolPort;
  readonly now?: () => string;
}

export function createRemoteToolActionCapability(
  input: CreateRemoteToolActionCapabilityInput,
): RemoteActionCapability {
  return createRemoteActionCapability({
    registration: input.registration,
    registrationResolver: input.registrationResolver,
    now: input.now,
    invokePort: {
      async invoke(invocation) {
        const remoteCallId = `remote_call_${invocation.actionId}`;
        const result = await input.remoteToolPort.call({
          id: remoteCallId,
          toolCallId: invocation.actionId,
          toolName: invocation.toolName,
          remoteNodeId: invocation.serverId,
          input: invocation.input,
          timeoutMs: invocation.timeoutMs,
          metadata: {},
        });
        if (result.remoteCallId !== remoteCallId ||
          result.toolResult.toolCallId !== invocation.actionId ||
          result.toolResult.toolName !== invocation.toolName) {
          throw codedError(
            "tool_remote_result_mismatch",
            "Remote tool result did not match the authorized invocation.",
          );
        }
        return {
          ...result.toolResult,
          toolCallId: invocation.actionId,
          toolName: invocation.actionName,
          metadata: {
            ...result.toolResult.metadata,
            remoteServerId: invocation.serverId,
            remoteToolName: invocation.toolName,
          },
        };
      },
    },
  });
}

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
