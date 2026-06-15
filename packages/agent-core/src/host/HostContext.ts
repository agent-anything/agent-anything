import type {
  IdentityProvider,
  IdentityRef,
} from "@agent-anything/governance/identity";
import type {
  WorkspaceContext,
  WorkspaceResolver,
} from "@agent-anything/governance/workspace";
import type { Metadata } from "@agent-anything/shared";

export interface CreateHostWorkspaceResolverInput {
  workspace?: WorkspaceContext;
  source?: string;
  metadata?: Metadata;
}

export function createHostWorkspaceResolver(
  input: CreateHostWorkspaceResolverInput = {},
): WorkspaceResolver {
  return {
    async resolve(resolveInput): Promise<WorkspaceContext> {
      return input.workspace ?? {
        id: "workspace_unknown",
        name: "Unknown workspace",
        rootRef: null,
        trustState: "unknown",
        source: input.source ?? "host-context",
        policyRefs: [],
        metadata: {
          ...input.metadata,
          taskId: resolveInput.taskId,
          cwd: resolveInput.cwd ?? null,
        },
      };
    },
  };
}

export interface CreateHostIdentityProviderInput {
  identity?: IdentityRef;
  source?: string;
  metadata?: Metadata;
}

export function createHostIdentityProvider(
  input: CreateHostIdentityProviderInput = {},
): IdentityProvider {
  return {
    async resolve(): Promise<IdentityRef> {
      return input.identity ?? {
        id: "anonymous",
        kind: "anonymous",
        displayName: "Anonymous",
        metadata: {
          ...input.metadata,
          source: input.source ?? "host-context",
        },
      };
    },
  };
}
