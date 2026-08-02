export type PermissionProfileResolutionErrorCode =
  | "invalid_profile_id"
  | "invalid_profile_definition"
  | "duplicate_profile_id"
  | "reserved_profile_id"
  | "unknown_base_profile"
  | "inheritance_cycle"
  | "profile_not_allowed"
  | "profile_denied"
  | "invalid_environment"
  | "invalid_workspace_root"
  | "duplicate_workspace_root"
  | "unknown_workspace_root"
  | "invalid_path"
  | "path_outside_workspace"
  | "invalid_glob"
  | "invalid_domain"
  | "invalid_managed_constraint"
  | "unenforced_execution_forbidden"
  | "invalid_metadata";

export class PermissionProfileResolutionError extends Error {
  readonly code: PermissionProfileResolutionErrorCode;

  constructor(code: PermissionProfileResolutionErrorCode, message: string) {
    super(message);
    this.name = "PermissionProfileResolutionError";
    this.code = code;
  }
}
