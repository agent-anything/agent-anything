import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RunWorkspace, WorkspaceContext } from "@agent-anything/agent-core/run";
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
  const { workspace: runWorkspace, requestedPath } = input;

  if (runWorkspace === null) {
    return reject(
      "workspace_missing",
      "Run workspace is required.",
      requestedPath,
    );
  }

  const roots = runWorkspaceEntries(runWorkspace);

  if (input.rootName !== undefined && input.rootName.trim().length === 0) {
    return reject(
      "workspace_root_name_invalid",
      "Requested workspace identity must be non-empty.",
      requestedPath,
      input.rootName,
    );
  }

  const selectedRootName =
    input.rootName ??
    runWorkspace.primary.id;

  const selectedRoot = roots.find(([rootName]) => rootName === selectedRootName);
  if (!selectedRoot) {
    return reject(
      "workspace_root_not_found",
      "Requested workspace is not part of the Run workspace.",
      requestedPath,
      selectedRootName,
    );
  }

  return {
    rootName: selectedRoot[0],
    workspace: selectedRoot[1],
  };
}

function runWorkspaceEntries(
  workspace: RunWorkspace,
): readonly (readonly [string, WorkspaceContext])[] {
  return [
    [workspace.primary.id, workspace.primary] as const,
    ...workspace.additional.map(
      (candidate) => [candidate.id, candidate] as const,
    ),
  ];
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
