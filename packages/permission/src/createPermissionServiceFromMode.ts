import type { PermissionMode } from "./PermissionMode.js";
import type { PermissionService } from "./PermissionService.js";
import { createDenyPermissionService } from "./createDenyPermissionService.js";
import { createTrustedPermissionService } from "./createTrustedPermissionService.js";
import { createUnavailablePermissionService } from "./createUnavailablePermissionService.js";

export function createPermissionServiceFromMode(
  permissionMode: PermissionMode,
): PermissionService {
  switch (permissionMode) {
    case "trusted":
      return createTrustedPermissionService();
    case "ask":
      return createUnavailablePermissionService();
    case "deny":
      return createDenyPermissionService();
  }
}
