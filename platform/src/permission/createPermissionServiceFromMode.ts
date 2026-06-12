import type { PermissionMode } from "./PermissionMode.js";
import type { PermissionRequestInput } from "./PermissionRequest.js";
import type { PermissionService } from "./PermissionService.js";
import { resolvePermissionDecision } from "./resolvePermissionDecision.js";

export function createPermissionServiceFromMode(
  permissionMode: PermissionMode,
): PermissionService {
  return {
    async request(request: PermissionRequestInput) {
      return resolvePermissionDecision({
        permissionMode,
        request,
      });
    },
  };
}
