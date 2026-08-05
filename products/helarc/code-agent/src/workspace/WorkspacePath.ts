import type { RunWorkspace, WorkspaceTrustState } from "@agent-anything/agent-core/run";

export type WorkspacePathErrorCode =
  | "workspace_missing"
  | "workspace_root_name_invalid"
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
  workspace: RunWorkspace | null;
  rootName?: string;
  requestedPath: string;
}
