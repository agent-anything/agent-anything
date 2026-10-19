import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { OperationCommitError } from "@agent-anything/operation-catalog/result";

export interface ShellExecutionSessionSnapshot {
  readonly revision: number;
  readonly rootName: string;
  readonly relativePath: string;
  readonly canonicalPath: string;
}

export interface ShellSessionCommit {
  readonly runId: string;
  readonly executionId: string;
  readonly before: ShellExecutionSessionSnapshot;
  readonly after: ShellExecutionSessionSnapshot;
}

export interface ShellSessionRecordPort {
  commitShellSession(commit: ShellSessionCommit): Promise<void>;
  readShellSession(runId: string): Promise<ShellSessionCommit | null>;
}

export function validateShellSessionCommit(value: ShellSessionCommit, prior: ShellSessionCommit | null): void {
  const snapshot = (s: ShellExecutionSessionSnapshot) => Number.isSafeInteger(s.revision) && s.revision >= 0 &&
    typeof s.rootName === "string" && s.rootName.length > 0 && typeof s.relativePath === "string" &&
    s.relativePath.length > 0 && typeof s.canonicalPath === "string" && isAbsolute(s.canonicalPath);
  if (!value.runId || !value.executionId || !snapshot(value.before) || !snapshot(value.after) ||
      value.after.revision !== value.before.revision + 1 ||
      (prior ? prior.runId !== value.runId || !sameSnapshot(prior.after, value.before) : value.before.revision !== 0)) {
    throw new OperationCommitError("helarc-shell-session", value.runId);
  }
}

function sameSnapshot(a: ShellExecutionSessionSnapshot, b: ShellExecutionSessionSnapshot): boolean {
  return a.revision === b.revision && a.rootName === b.rootName && a.relativePath === b.relativePath && a.canonicalPath === b.canonicalPath;
}

export class ShellExecutionSession {
  private state: ShellExecutionSessionSnapshot;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly workspace: WorkspaceSelection,
    private readonly platform: "win32" | "posix",
    private readonly initial: ShellExecutionSessionSnapshot,
    private readonly commit?: (value: {before: ShellExecutionSessionSnapshot; after: ShellExecutionSessionSnapshot; executionId: string}) => Promise<void>,
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

  forkInitial(commit?: ShellExecutionSession["commit"]): ShellExecutionSession {
    return new ShellExecutionSession(this.workspace,this.platform,this.initial,commit);
  }

  async restore(value: ShellSessionCommit): Promise<void> {
    if (this.state.revision !== 0) throw new TypeError("Shell session is already active.");
    const selected = [this.workspace.primary, ...this.workspace.additional].find(root => root.id === value.after.rootName);
    if (!selected?.rootRef) throw new TypeError("Retained Shell session root is unavailable.");
    const canonicalRoot = await realpath(selected.rootRef);
    const canonicalPath = await realpath(value.after.canonicalPath);
    const relativePath = relative(canonicalRoot, canonicalPath) || ".";
    if (canonicalPath !== value.after.canonicalPath || relativePath !== value.after.relativePath || !isWithinRoot(relativePath, this.platform)) {
      throw new TypeError("Retained Shell session path changed.");
    }
    this.state = Object.freeze({...value.after});
  }

  commitFinalWorkingDirectory(input: {
    readonly expectedRevision: number;
    readonly path: string;
    readonly executionId?: string;
  }): Promise<ShellExecutionSessionSnapshot | null> {
    const result = this.tail.then(() => this.commitDirectory(input));
    // A failed durable commit closes this session until owner recovery.
    this.tail = result;
    return result;
  }

  private async commitDirectory(input: {readonly expectedRevision: number; readonly path: string; readonly executionId?: string}): Promise<ShellExecutionSessionSnapshot | null> {
    if (input.expectedRevision !== this.state.revision || !isAbsolute(input.path)) {
      return null;
    }
    const canonicalPath = await realpath(input.path);
    for (const selected of [this.workspace.primary, ...this.workspace.additional]) {
      if (selected.rootRef === null) continue;
      const canonicalRoot = await realpath(selected.rootRef);
      const relativePath = relative(canonicalRoot, canonicalPath);
      if (!isWithinRoot(relativePath, this.platform)) continue;
      if (input.expectedRevision !== this.state.revision) return null;
      const next = Object.freeze({
        revision: this.state.revision + 1,
        rootName: selected.id,
        relativePath: relativePath.length === 0 ? "." : relativePath,
        canonicalPath,
      });
      if (this.commit) {
        if (!input.executionId) throw new TypeError("Durable Shell session requires execution identity.");
        try { await this.commit({before: this.state, after: next, executionId: input.executionId}); }
        catch (cause) { throw new OperationCommitError("helarc-shell-session", input.executionId, {cause}); }
      }
      this.state = next;
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
