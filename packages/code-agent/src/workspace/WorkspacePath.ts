import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import type { WorkspaceTrustState } from "@agent-anything/governance";

export type WorkspacePathErrorCode =
  | "workspace_scope_missing"
  | "workspace_scope_empty"
  | "workspace_root_name_invalid"
  | "workspace_root_name_required"
  | "workspace_root_not_found"
  | "workspace_root_missing"
  | "workspace_root_not_absolute"
  | "requested_path_missing"
  | "absolute_path_not_allowed"
  | "path_outside_workspace";

export interface WorkspacePathError {
  code: WorkspacePathErrorCode;
  message: string;
  rootName: string | null;
  workspaceId: string | null;
  requestedPath: string;
}

export interface ResolvedWorkspacePath {
  status: "resolved";
  rootName: string;
  workspaceId: string;
  trustState: WorkspaceTrustState;
  workspaceRoot: string;
  relativePath: string;
  absolutePath: string;
}

export interface RejectedWorkspacePath {
  status: "rejected";
  error: WorkspacePathError;
}

export type WorkspacePathResolution =
  | ResolvedWorkspacePath
  | RejectedWorkspacePath;

export interface ResolveWorkspacePathInput {
  workspaceScope: TaskWorkspaceScope | undefined;
  rootName?: string;
  requestedPath: string;
}
