import type { Metadata } from "@agent-anything/shared";
import type { WorkspaceContext } from "./WorkspaceContext.js";

export interface ResolveWorkspaceInput {
  taskId: string;
  cwd?: string | null;
  metadata: Metadata;
}

export interface WorkspaceResolver {
  resolve(input: ResolveWorkspaceInput): Promise<WorkspaceContext>;
}

export interface CreateDefaultWorkspaceResolverInput {
  workspaceId?: string;
  name?: string;
  rootRef?: string | null;
  policyRefs?: string[];
  metadata?: Metadata;
}

export function createDefaultWorkspaceResolver(
  input: CreateDefaultWorkspaceResolverInput = {},
): WorkspaceResolver {
  return {
    async resolve(resolveInput): Promise<WorkspaceContext> {
      return {
        id: input.workspaceId ?? "workspace_local",
        name: input.name ?? "Local workspace",
        rootRef: input.rootRef ?? resolveInput.cwd ?? null,
        policyRefs: input.policyRefs ?? [],
        metadata: {
          ...input.metadata,
          source: "default-workspace-resolver",
        },
      };
    },
  };
}
