import type { PermissionService } from "./PermissionService.js";

export function createTrustedPermissionService(): PermissionService {
  return {
    async request(input) {
      return {
        requestId: input.id,
        status: "granted",
        reason: "Granted by permissionMode: trusted.",
        decidedAt: new Date().toISOString(),
      };
    },
  };
}
