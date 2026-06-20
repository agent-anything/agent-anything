import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core";
import {
  resolveWorkspacePath,
  type ResolvedWorkspacePath,
} from "../workspace/index.js";
import { FileToolError } from "./FileToolError.js";

export interface ExistingWorkspaceTarget {
  resolved: ResolvedWorkspacePath;
  canonicalRoot: string;
  canonicalTarget: string;
  stats: Stats;
}

export interface WritableWorkspaceTarget extends ExistingWorkspaceTarget {
  created: boolean;
}

export async function resolveExistingTarget(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  rootName?: string;
  path: string;
  expectedKind: "file" | "directory" | "fileOrDirectory";
}): Promise<ExistingWorkspaceTarget> {
  const resolved = resolveLexicalPath(input);
  const canonicalRoot = await resolveCanonicalRoot(resolved);
  const canonicalTarget = await resolveCanonicalTarget(resolved);
  assertCanonicalContainment(canonicalRoot, canonicalTarget, resolved);
  const targetStats = await stat(canonicalTarget);

  if (input.expectedKind === "file" && !targetStats.isFile()) {
    throw new FileToolError(
      "file_not_file",
      "Workspace path does not identify a file.",
      pathMetadata(resolved),
    );
  }

  if (input.expectedKind === "directory" && !targetStats.isDirectory()) {
    throw new FileToolError(
      "file_not_directory",
      "Workspace path does not identify a directory.",
      pathMetadata(resolved),
    );
  }

  return {
    resolved,
    canonicalRoot,
    canonicalTarget,
    stats: targetStats,
  };
}

export async function resolveWritableTarget(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  rootName?: string;
  path: string;
  overwrite: boolean;
}): Promise<WritableWorkspaceTarget> {
  const resolved = resolveLexicalPath(input);
  const canonicalRoot = await resolveCanonicalRoot(resolved);

  try {
    await lstat(resolved.absolutePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw toFilesystemError(error, resolved);
    }

    const parentPath = dirname(resolved.absolutePath);
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parentPath);
    } catch (parentError) {
      if (isNodeError(parentError, "ENOENT")) {
        throw new FileToolError(
          "file_parent_not_found",
          "Parent directory does not exist.",
          pathMetadata(resolved),
        );
      }
      throw toFilesystemError(parentError, resolved);
    }

    assertCanonicalContainment(canonicalRoot, canonicalParent, resolved);
    const parentStats = await stat(canonicalParent);
    if (!parentStats.isDirectory()) {
      throw new FileToolError(
        "file_parent_not_directory",
        "Parent path is not a directory.",
        pathMetadata(resolved),
      );
    }

    return {
      resolved,
      canonicalRoot,
      canonicalTarget: join(canonicalParent, basename(resolved.absolutePath)),
      stats: parentStats,
      created: true,
    };
  }

  const canonicalTarget = await resolveCanonicalTarget(resolved);
  assertCanonicalContainment(canonicalRoot, canonicalTarget, resolved);
  const targetStats = await stat(canonicalTarget);

  if (!targetStats.isFile()) {
    throw new FileToolError(
      "file_not_file",
      "Workspace path does not identify a file.",
      pathMetadata(resolved),
    );
  }

  if (!input.overwrite) {
    throw new FileToolError(
      "file_already_exists",
      "File already exists and overwrite is not enabled.",
      pathMetadata(resolved),
    );
  }

  return {
    resolved,
    canonicalRoot,
    canonicalTarget,
    stats: targetStats,
    created: false,
  };
}

export function workspaceRelativePath(
  canonicalRoot: string,
  canonicalTarget: string,
): string {
  const value = relative(canonicalRoot, canonicalTarget);
  return value.length === 0 ? "." : value.split(sep).join("/");
}

function resolveLexicalPath(input: {
  workspaceScope: TaskWorkspaceScope | undefined;
  rootName?: string;
  path: string;
}): ResolvedWorkspacePath {
  const resolution = resolveWorkspacePath({
    workspaceScope: input.workspaceScope,
    rootName: input.rootName,
    requestedPath: input.path,
  });

  if (resolution.status === "rejected") {
    throw new FileToolError(
      resolution.error.code,
      resolution.error.message,
      {
        rootName: resolution.error.rootName,
        workspaceId: resolution.error.workspaceId,
        path: resolution.error.requestedPath,
      },
    );
  }

  return resolution;
}

async function resolveCanonicalRoot(
  resolved: ResolvedWorkspacePath,
): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolved.workspaceRoot);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new FileToolError(
        "workspace_root_not_found",
        "Selected workspace root does not exist.",
        pathMetadata(resolved),
      );
    }
    throw toFilesystemError(error, resolved);
  }

  const rootStats = await stat(canonicalRoot);
  if (!rootStats.isDirectory()) {
    throw new FileToolError(
      "workspace_root_not_directory",
      "Selected workspace root is not a directory.",
      pathMetadata(resolved),
    );
  }

  return canonicalRoot;
}

async function resolveCanonicalTarget(
  resolved: ResolvedWorkspacePath,
): Promise<string> {
  try {
    return await realpath(resolved.absolutePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new FileToolError(
        "file_not_found",
        "Workspace path does not exist.",
        pathMetadata(resolved),
      );
    }
    throw toFilesystemError(error, resolved);
  }
}

function assertCanonicalContainment(
  canonicalRoot: string,
  canonicalTarget: string,
  resolved: ResolvedWorkspacePath,
): void {
  const relativeTarget = relative(canonicalRoot, canonicalTarget);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(".." + sep) ||
    isAbsolute(relativeTarget)
  ) {
    throw new FileToolError(
      "workspace_symlink_escape",
      "Workspace path resolves outside the selected root.",
      pathMetadata(resolved),
    );
  }
}

function pathMetadata(resolved: ResolvedWorkspacePath) {
  return {
    rootName: resolved.rootName,
    workspaceId: resolved.workspaceId,
    path: resolved.relativePath,
  };
}

function toFilesystemError(
  error: unknown,
  resolved: ResolvedWorkspacePath,
): FileToolError {
  return new FileToolError(
    "file_operation_failed",
    "Filesystem operation failed.",
    pathMetadata(resolved),
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
