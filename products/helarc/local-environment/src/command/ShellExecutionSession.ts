import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";

export interface ShellExecutionSessionSnapshot {
  readonly revision: number;
  readonly rootName: string;
  readonly relativePath: string;
  readonly canonicalPath: string;
}

export class ShellExecutionSession {
  private state: ShellExecutionSessionSnapshot;

  private constructor(
    private readonly workspace: WorkspaceSelection,
    private readonly platform: "win32" | "posix",
    initial: ShellExecutionSessionSnapshot,
  ) {
    this.state = initial;
  }

  static async create(
    workspace: WorkspaceSelection,
    platform: "win32" | "posix",
  ): Promise<ShellExecutionSession> {
    if (workspace.primary.rootRef === null) {
      throw new TypeError("Shell execution requires a filesystem-backed primary Workspace.");
    }
    const canonicalPath = await realpath(workspace.primary.rootRef);
    return new ShellExecutionSession(workspace, platform, Object.freeze({
      revision: 0,
      rootName: workspace.primary.id,
      relativePath: ".",
      canonicalPath,
    }));
  }

  snapshot(): ShellExecutionSessionSnapshot {
    return this.state;
  }

  async commitFinalWorkingDirectory(input: {
    readonly expectedRevision: number;
    readonly path: string;
  }): Promise<ShellExecutionSessionSnapshot | null> {
    if (input.expectedRevision !== this.state.revision || !isAbsolute(input.path)) {
      return null;
    }
    const canonicalPath = await realpath(input.path);
    for (const selected of [this.workspace.primary, ...this.workspace.additional]) {
      if (selected.rootRef === null) continue;
      const canonicalRoot = await realpath(selected.rootRef);
      const relativePath = relative(canonicalRoot, canonicalPath);
      if (!isWithinRoot(relativePath, this.platform)) continue;
      this.state = Object.freeze({
        revision: this.state.revision + 1,
        rootName: selected.id,
        relativePath: relativePath.length === 0 ? "." : relativePath,
        canonicalPath,
      });
      return this.state;
    }
    return null;
  }
}

function isWithinRoot(value: string, platform: "win32" | "posix"): boolean {
  if (value.length === 0) return true;
  if (isAbsolute(value)) return false;
  const normalized = platform === "win32" ? value.replaceAll("/", "\\") : value;
  return normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.startsWith("..\\");
}
