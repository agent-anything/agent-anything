import type { ISODateTimeString } from "../shared/types";
import type { PermissionDecision } from "./PermissionDecision";
import type { PermissionMode } from "./PermissionMode";
import type { PermissionRequest } from "./PermissionRequest";

export interface ResolvePermissionDecisionInput {
  permissionMode: PermissionMode;
  request: PermissionRequest;
  decidedAt?: ISODateTimeString;
}

export function resolvePermissionDecision(
  input: ResolvePermissionDecisionInput,
): PermissionDecision {
  return {
    requestId: input.request.id,
    status: input.permissionMode === "allowAll" ? "allowed" : "denied",
    reason: createDecisionReason(input.permissionMode),
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  };
}

function createDecisionReason(permissionMode: PermissionMode): string {
  if (permissionMode === "allowAll") {
    return "Allowed by Phase1 permissionMode: allowAll.";
  }

  return "Denied by Phase1 permissionMode: denyAll.";
}
