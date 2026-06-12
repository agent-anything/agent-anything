import type { PermissionService } from "./PermissionService.js";

export function createDenyPermissionService(): PermissionService {
  return {
    async request(input) {
      return {
        requestId: input.id,
        status: "denied",
        code: "permission_mode_denied",
        reason: "Denied by permissionMode: deny.",
        decidedAt: new Date().toISOString(),
      };
    },
  };
}
