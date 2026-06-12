import type { ISODateTimeString } from "../shared/types.js";
import type { PermissionDecision } from "./PermissionDecision.js";
import type { PermissionMode } from "./PermissionMode.js";
import type { PermissionRequestInput } from "./PermissionRequest.js";

export interface ResolvePermissionDecisionInput {
  permissionMode: PermissionMode;
  request: PermissionRequestInput;
  decidedAt?: ISODateTimeString;
}

export function resolvePermissionDecision(
  input: ResolvePermissionDecisionInput,
): PermissionDecision {
  if (input.permissionMode === "trusted") {
    return {
      requestId: input.request.id,
      status: "granted",
      reason: "Granted by permissionMode: trusted.",
      decidedAt: input.decidedAt ?? new Date().toISOString(),
    };
  }

  const code = input.permissionMode === "ask"
    ? "permission_unavailable"
    : "permission_mode_denied";

  return {
    requestId: input.request.id,
    status: "denied",
    code,
    reason: createDecisionReason(input.permissionMode),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  };
}

function createDecisionReason(permissionMode: PermissionMode): string {
  if (permissionMode === "ask") {
    return "Denied because permissionMode: ask requires a host-provided prompt service.";
  }

  return "Denied by permissionMode: deny.";
}
