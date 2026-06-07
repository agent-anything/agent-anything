import type { PermissionRequest } from "./PermissionRequest.js";
import type { PermissionServiceResult } from "./PermissionServiceResult.js";

export interface PermissionService {
  decide(request: PermissionRequest): Promise<PermissionServiceResult>;
}
