import type { PermissionRequestInput } from "./PermissionRequest.js";
import type { PermissionServiceResult } from "./PermissionServiceResult.js";

export interface PermissionService {
  request(input: PermissionRequestInput): Promise<PermissionServiceResult>;
}
