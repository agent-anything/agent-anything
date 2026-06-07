import type { PermissionMode } from "./PermissionMode.js";
import type { PermissionRequest } from "./PermissionRequest.js";
import type { PermissionService } from "./PermissionService.js";
import { resolvePermissionDecision } from "./resolvePermissionDecision.js";

export function createPermissionServiceFromMode(
  permissionMode: PermissionMode,
): PermissionService {
  return {
    async decide(request: PermissionRequest) {
      return resolvePermissionDecision({
        permissionMode,
        request,
      });
    },
  };
}
