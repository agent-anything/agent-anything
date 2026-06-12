import type { PermissionService } from "./PermissionService.js";

export function createUnavailablePermissionService(): PermissionService {
  return {
    async request(input) {
      return {
        requestId: input.id,
        status: "denied",
        code: "permission_unavailable",
        reason: "Denied because permissionMode: ask requires a host-provided prompt service.",
        decidedAt: new Date().toISOString(),
      };
    },
  };
}
