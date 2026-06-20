import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceContext } from "@agent-anything/governance";
import type {
  RejectedWorkspacePath,
  ResolveWorkspacePathInput,
  WorkspacePathErrorCode,
  WorkspacePathResolution,
} from "./WorkspacePath.js";

export function resolveWorkspacePath(
  input: ResolveWorkspacePathInput,
): WorkspacePathResolution {
  const selection = selectWorkspace(input);
  if ("error" in selection) {
    return selection;
  }

  const { rootName, workspace } = selection;
  const { requestedPath } = input;
  const rootRef = workspace.rootRef;

  if (rootRef === null || rootRef.trim().length === 0) {
    return reject(
      "workspace_root_missing",
      "Selected workspace root is required.",
      requestedPath,
      rootName,
      workspace.id,
    );
  }

  if (!isAbsolute(rootRef)) {
    return reject(
      "workspace_root_not_absolute",
      "Selected workspace root must be an absolute path.",
      requestedPath,
      rootName,
      workspace.id,
    );
  }

  if (requestedPath.trim().length === 0) {
    return reject(
      "requested_path_missing",
      "Requested path is required.",
      requestedPath,
      rootName,
      workspace.id,
    );
  }

  if (isAbsolute(requestedPath)) {
    return reject(
      "absolute_path_not_allowed",
      "Requested path must be relative to the selected workspace root.",
      requestedPath,
      rootName,
      workspace.id,
    );
  }

  const workspaceRoot = resolve(rootRef);
  const absolutePath = resolve(workspaceRoot, requestedPath);
  const workspaceRelativePath = relative(workspaceRoot, absolutePath);

  if (
    workspaceRelativePath === ".." ||
    workspaceRelativePath.startsWith(".." + sep) ||
    isAbsolute(workspaceRelativePath)
  ) {
    return reject(
      "path_outside_workspace",
      "Requested path resolves outside the selected workspace root.",
      requestedPath,
      rootName,
      workspace.id,
    );
  }

  return {
    status: "resolved",
    rootName,
    workspaceId: workspace.id,
    trustState: workspace.trustState,
    workspaceRoot,
    relativePath:
      workspaceRelativePath.length === 0
        ? "."
        : workspaceRelativePath.split(sep).join("/"),
    absolutePath,
  };
}

function selectWorkspace(
  input: ResolveWorkspacePathInput,
):
  | { rootName: string; workspace: WorkspaceContext }
  | RejectedWorkspacePath {
  const { workspaceScope, requestedPath } = input;

  if (workspaceScope === undefined) {
    return reject(
      "workspace_scope_missing",
      "Task workspace scope is required.",
      requestedPath,
    );
  }

  const roots = Object.entries(workspaceScope.roots);
  if (roots.length === 0) {
    return reject(
      "workspace_scope_empty",
      "Task workspace scope must declare at least one root.",
      requestedPath,
    );
  }

  const invalidRoot = roots.find(([rootName]) => rootName.trim().length === 0);
  if (invalidRoot) {
    return reject(
      "workspace_root_name_invalid",
      "Task workspace root names must be non-empty.",
      requestedPath,
      invalidRoot[0],
      invalidRoot[1].id,
    );
  }

  const defaultRootName = workspaceScope.defaultRootName;
  if (defaultRootName !== undefined && defaultRootName.trim().length === 0) {
    return reject(
      "workspace_root_name_invalid",
      "Default task workspace root name must be non-empty.",
      requestedPath,
      defaultRootName,
    );
  }

  if (
    defaultRootName !== undefined &&
    !roots.some(([rootName]) => rootName === defaultRootName)
  ) {
    return reject(
      "workspace_root_not_found",
      "Default task workspace root is not declared in the scope.",
      requestedPath,
      defaultRootName,
    );
  }

  if (input.rootName !== undefined && input.rootName.trim().length === 0) {
    return reject(
      "workspace_root_name_invalid",
      "Requested task workspace root name must be non-empty.",
      requestedPath,
      input.rootName,
    );
  }

  const selectedRootName =
    input.rootName ??
    defaultRootName ??
    (roots.length === 1 ? roots[0]![0] : undefined);

  if (selectedRootName === undefined) {
    return reject(
      "workspace_root_name_required",
      "A task workspace root name is required when the scope has multiple roots and no default.",
      requestedPath,
    );
  }

  const selectedRoot = roots.find(([rootName]) => rootName === selectedRootName);
  if (!selectedRoot) {
    return reject(
      "workspace_root_not_found",
      "Requested task workspace root is not declared in the scope.",
      requestedPath,
      selectedRootName,
    );
  }

  return {
    rootName: selectedRoot[0],
    workspace: selectedRoot[1],
  };
}

function reject(
  code: WorkspacePathErrorCode,
  message: string,
  requestedPath: string,
  rootName: string | null = null,
  workspaceId: string | null = null,
): RejectedWorkspacePath {
  return {
    status: "rejected",
    error: {
      code,
      message,
      rootName,
      workspaceId,
      requestedPath,
    },
  };
}
