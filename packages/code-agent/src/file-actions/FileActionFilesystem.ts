import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CanonicalPathIdentityInput,
  CanonicalWorkspaceRootIdentity,
  CanonicalWorkspaceRootIdentityInput,
  FileBaseline,
} from "@agent-anything/agent-core/action-execution";
import { createCanonicalSha256Digest } from "@agent-anything/agent-core/action-execution";
import type { TaskWorkspaceScope } from "@agent-anything/agent-core/task";
import {
  resolveExistingTarget,
  resolveWritableTarget,
} from "../filesystem/FileSystemBoundary.js";
import type { CodeAgentPreparedFileOperation } from "./FileActionContracts.js";

type FileSystemPlatform = "win32" | "posix";

export interface PreparedFileSystemTarget {
  readonly rootName: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly relativePath: string;
  readonly canonicalTarget: string;
  readonly pathIdentity: CanonicalPathIdentityInput;
  readonly baseline: FileBaseline;
  readonly workspaceRootIdentity: CanonicalWorkspaceRootIdentity;
}

export async function createCodeAgentCanonicalWorkspaceRoots(input: {
  readonly workspaceScope: TaskWorkspaceScope | undefined;
  readonly platform: FileSystemPlatform;
}): Promise<readonly CanonicalWorkspaceRootIdentityInput[]> {
  if (input.workspaceScope === undefined) {
    throw new TypeError("Code-agent file Actions require a task workspace scope.");
  }
  const entries = Object.entries(input.workspaceScope.roots);
  if (entries.length === 0) {
    throw new TypeError("Code-agent file Actions require at least one workspace root.");
  }

  return Promise.all(entries.map(async ([rootName, workspace]) => {
    if (workspace.rootRef === null) {
      throw new TypeError(`Workspace root '${rootName}' has no filesystem path.`);
    }
    const lexicalPath = resolve(workspace.rootRef);
    const resolvedPath = await realpath(lexicalPath);
    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw new TypeError(`Workspace root '${rootName}' is not a directory.`);
    }
    const rootId = workspace.id || rootName;
    return {
      rootId,
      platform: input.platform,
      path: lexicalPath,
      resolvedPath,
      resolutionFingerprint: await rootResolutionFingerprint({
        platform: input.platform,
        rootId,
        path: lexicalPath,
        resolvedPath,
        stats,
      }),
    };
  }));
}

export async function prepareFileSystemTarget(input: {
  readonly workspaceScope: TaskWorkspaceScope | undefined;
  readonly workspaceRoots: readonly CanonicalWorkspaceRootIdentity[];
  readonly platform: FileSystemPlatform;
  readonly rootName?: string;
  readonly path: string;
  readonly operation: CodeAgentPreparedFileOperation;
}): Promise<PreparedFileSystemTarget> {
  const mutation = input.operation === "create" || input.operation === "update" ||
    input.operation === "delete";
  const target = input.operation === "create"
    ? await resolveWritableTarget({
        workspaceScope: input.workspaceScope,
        rootName: input.rootName,
        path: input.path,
        overwrite: false,
      })
    : await resolveExistingTarget({
        workspaceScope: input.workspaceScope,
        rootName: input.rootName,
        path: input.path,
        expectedKind: input.operation === "list"
          ? "directory"
          : input.operation === "read" || mutation
            ? "file"
            : "fileOrDirectory",
      });

  if (mutation && input.operation !== "create") {
    const lexicalStats = await lstat(target.resolved.absolutePath);
    if (lexicalStats.isSymbolicLink()) {
      throw new TypeError("File mutation targets must not be symbolic links.");
    }
  }

  const workspaceRootIdentity = input.workspaceRoots.find(
    (root) => root.rootId === target.resolved.workspaceId,
  );
  if (workspaceRootIdentity === undefined) {
    throw new TypeError("Selected workspace root is absent from the canonical Action context.");
  }
  if (!sameCanonicalPath(
    workspaceRootIdentity.resolvedPath,
    target.canonicalRoot,
    input.platform,
  )) {
    throw new TypeError("Selected workspace root no longer matches the canonical Action context.");
  }

  const rootStats = await stat(target.canonicalRoot);
  const actualRootFingerprint = await rootResolutionFingerprint({
    platform: input.platform,
    rootId: workspaceRootIdentity.rootId,
    path: workspaceRootIdentity.canonicalPath,
    resolvedPath: target.canonicalRoot,
    stats: rootStats,
  });
  if (actualRootFingerprint !== workspaceRootIdentity.resolutionFingerprint) {
    throw new TypeError("Selected workspace root identity changed before Action preparation.");
  }

  const baseline = input.operation === "create"
    ? ({ kind: "absent" } as const)
    : await createBaseline(target.canonicalTarget, target.stats, input.platform);
  const isWorkspaceRootTarget = sameCanonicalPath(
    target.canonicalTarget,
    target.canonicalRoot,
    input.platform,
  );
  const resolutionFingerprint = isWorkspaceRootTarget
    ? workspaceRootIdentity.resolutionFingerprint
    : await createCanonicalSha256Digest(
        "agent-anything.code-agent.file-path-resolution.v1",
        {
          platform: input.platform,
          workspaceRootId: workspaceRootIdentity.rootId,
          workspaceRootFingerprint: workspaceRootIdentity.resolutionFingerprint,
          lexicalPath: canonicalFingerprintPath(target.resolved.absolutePath, input.platform),
          resolvedPath: canonicalFingerprintPath(target.canonicalTarget, input.platform),
        },
      );

  return Object.freeze({
    rootName: target.resolved.rootName,
    workspaceId: target.resolved.workspaceId,
    workspaceRoot: target.resolved.workspaceRoot,
    canonicalRoot: target.canonicalRoot,
    relativePath: target.resolved.relativePath,
    canonicalTarget: target.canonicalTarget,
    pathIdentity: Object.freeze({
      platform: input.platform,
      path: isWorkspaceRootTarget
        ? workspaceRootIdentity.canonicalPath
        : target.resolved.absolutePath,
      resolvedPath: isWorkspaceRootTarget
        ? workspaceRootIdentity.resolvedPath
        : target.canonicalTarget,
      workspaceRootId: workspaceRootIdentity.rootId,
      resolutionFingerprint,
    }),
    baseline,
    workspaceRootIdentity,
  });
}

export async function inspectPreparedFileSystemTarget(input: {
  readonly platform: FileSystemPlatform;
  readonly operation: CodeAgentPreparedFileOperation;
  readonly workspaceRootIdentity: CanonicalWorkspaceRootIdentity;
  readonly workspaceRoot: string;
  readonly canonicalRoot: string;
  readonly canonicalTarget: string;
  readonly path: string;
}): Promise<{ readonly pathIdentity: CanonicalPathIdentityInput; readonly baseline: FileBaseline }> {
  const resolvedRoot = await realpath(input.workspaceRoot);
  if (!sameCanonicalPath(resolvedRoot, input.canonicalRoot, input.platform) ||
    !sameCanonicalPath(resolvedRoot, input.workspaceRootIdentity.resolvedPath, input.platform)) {
    throw new TypeError("Workspace root resolution changed.");
  }
  const rootStats = await stat(resolvedRoot);
  const rootFingerprint = await rootResolutionFingerprint({
    platform: input.platform,
    rootId: input.workspaceRootIdentity.rootId,
    path: input.workspaceRootIdentity.canonicalPath,
    resolvedPath: resolvedRoot,
    stats: rootStats,
  });
  if (rootFingerprint !== input.workspaceRootIdentity.resolutionFingerprint) {
    throw new TypeError("Workspace root identity changed.");
  }

  let resolvedTarget: string;
  let baseline: FileBaseline;
  if (input.operation === "create") {
    try {
      await lstat(input.path);
      throw new TypeError("Create target now exists.");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const parent = await realpath(dirname(input.path));
    resolvedTarget = join(parent, basename(input.path));
    if (!sameCanonicalPath(resolvedTarget, input.canonicalTarget, input.platform)) {
      throw new TypeError("Create target resolution changed.");
    }
    baseline = Object.freeze({ kind: "absent" as const });
  } else {
    resolvedTarget = await realpath(input.path);
    if (!sameCanonicalPath(resolvedTarget, input.canonicalTarget, input.platform)) {
      throw new TypeError("File target resolution changed.");
    }
    const stats = await stat(resolvedTarget);
    baseline = await createBaseline(resolvedTarget, stats, input.platform);
  }

  const isWorkspaceRootTarget = sameCanonicalPath(
    resolvedTarget,
    resolvedRoot,
    input.platform,
  );
  return Object.freeze({
    pathIdentity: Object.freeze({
      platform: input.platform,
      path: isWorkspaceRootTarget
        ? input.workspaceRootIdentity.canonicalPath
        : input.path,
      resolvedPath: isWorkspaceRootTarget
        ? input.workspaceRootIdentity.resolvedPath
        : resolvedTarget,
      workspaceRootId: input.workspaceRootIdentity.rootId,
      resolutionFingerprint: isWorkspaceRootTarget
        ? input.workspaceRootIdentity.resolutionFingerprint
        : await createCanonicalSha256Digest(
            "agent-anything.code-agent.file-path-resolution.v1",
            {
              platform: input.platform,
              workspaceRootId: input.workspaceRootIdentity.rootId,
              workspaceRootFingerprint: input.workspaceRootIdentity.resolutionFingerprint,
              lexicalPath: canonicalFingerprintPath(input.path, input.platform),
              resolvedPath: canonicalFingerprintPath(resolvedTarget, input.platform),
            },
          ),
    }),
    baseline,
  });
}

async function createBaseline(
  target: string,
  stats: Stats,
  platform: FileSystemPlatform,
): Promise<FileBaseline> {
  const entryKind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
  const contentDigest = stats.isFile()
    ? `sha256:${createHash("sha256").update(await readFile(target)).digest("hex")}`
    : null;
  return Object.freeze({
    kind: "present" as const,
    entryKind,
    objectIdentity: platform === "win32"
      ? Object.freeze({
          kind: "win32" as const,
          volumeId: String(stats.dev),
          fileId: String(stats.ino),
        })
      : Object.freeze({
          kind: "posix" as const,
          deviceId: String(stats.dev),
          inode: String(stats.ino),
        }),
    contentDigest,
  });
}

async function rootResolutionFingerprint(input: {
  readonly platform: FileSystemPlatform;
  readonly rootId: string;
  readonly path: string;
  readonly resolvedPath: string;
  readonly stats: Stats;
}): Promise<string> {
  return createCanonicalSha256Digest(
    "agent-anything.code-agent.workspace-root-resolution.v1",
    {
      platform: input.platform,
      rootId: input.rootId,
      path: canonicalFingerprintPath(input.path, input.platform),
      resolvedPath: canonicalFingerprintPath(input.resolvedPath, input.platform),
      device: String(input.stats.dev),
      inode: String(input.stats.ino),
    },
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function sameCanonicalPath(
  left: string | null,
  right: string | null,
  platform: FileSystemPlatform,
): boolean {
  if (left === null || right === null) return left === right;
  const leftValue = canonicalFingerprintPath(left, platform);
  const rightValue = canonicalFingerprintPath(right, platform);
  return platform === "win32"
    ? leftValue.toLowerCase() === rightValue.toLowerCase()
    : leftValue === rightValue;
}

function canonicalFingerprintPath(
  value: string,
  platform: FileSystemPlatform,
): string {
  const normalized = platform === "win32" ? value.replaceAll("\\", "/") : value;
  const withoutTrailingSlash = normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  return platform === "win32" && /^[a-z]:/.test(withoutTrailingSlash)
    ? withoutTrailingSlash[0]!.toUpperCase() + withoutTrailingSlash.slice(1)
    : withoutTrailingSlash;
}
