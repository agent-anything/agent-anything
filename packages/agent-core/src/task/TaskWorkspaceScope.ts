import type { WorkspaceContext } from "@agent-anything/governance";

export interface TaskWorkspaceScope {
  roots: Readonly<Record<string, WorkspaceContext>>;
  defaultRootName?: string;
}
