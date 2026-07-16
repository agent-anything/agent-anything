import type { IdentityRef, WorkspaceContext } from "@agent-anything/governance";
import type { ResolvedPermissionProfile } from "@agent-anything/permission";
import {
  createCanonicalActorIdentity,
  createCanonicalEnvironmentIdentity,
  createCanonicalWorkspaceIdentity,
  type CanonicalActorIdentity,
  type CanonicalEnvironmentIdentity,
  type CanonicalEnvironmentIdentityInput,
  type CanonicalWorkspaceIdentity,
  type CanonicalWorkspaceIdentityInput,
} from "../action-execution/CanonicalIdentity.js";

export interface RunActionContextInput {
  readonly workspace: CanonicalWorkspaceIdentityInput;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentityInput;
}

export interface RunActionContext {
  readonly workspace: CanonicalWorkspaceIdentity;
  readonly actor: CanonicalActorIdentity;
  readonly environment: CanonicalEnvironmentIdentity;
}

export function snapshotRunActionContext(input: {
  readonly context: RunActionContextInput | RunActionContext;
  readonly workspace: WorkspaceContext;
  readonly identity: IdentityRef;
  readonly profile: ResolvedPermissionProfile;
}): RunActionContext {
  const context = input.context;
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("RunConfig.actionContext must be a canonical Action context.");
  }
  const workspaceInput: CanonicalWorkspaceIdentityInput = isCanonicalWorkspace(context.workspace)
    ? {
        workspaceId: context.workspace.workspaceId,
        trustState: context.workspace.trustState,
        roots: context.workspace.roots.map((root) => ({
          rootId: root.rootId,
          platform: root.platform,
          path: root.canonicalPath,
          resolvedPath: root.resolvedPath ?? root.canonicalPath,
          resolutionFingerprint: root.resolutionFingerprint,
        })),
      }
    : context.workspace;
  const workspace = createCanonicalWorkspaceIdentity(workspaceInput);
  const actor = createCanonicalActorIdentity(context.actor);
  const environment = createCanonicalEnvironmentIdentity(context.environment);

  if (workspace.workspaceId !== input.workspace.id ||
    workspace.trustState !== input.workspace.trustState) {
    throw new TypeError("Action context workspace identity does not match RunConfig.workspace.");
  }
  if (actor.identityId !== input.identity.id || actor.kind !== input.identity.kind) {
    throw new TypeError("Action context actor identity does not match RunConfig.identity.");
  }
  if (environment.environmentId !== input.profile.environmentId ||
    environment.platform !== input.profile.platform) {
    throw new TypeError("Action context environment does not match the Permission Profile.");
  }
  if (workspace.roots.length !== input.profile.workspaceRoots.length) {
    throw new TypeError("Action context roots do not match the Permission Profile.");
  }
  for (const profileRoot of input.profile.workspaceRoots) {
    const actionRoot = workspace.roots.find((candidate) => candidate.rootId === profileRoot.rootId);
    if (actionRoot === undefined || actionRoot.canonicalPath !== profileRoot.canonicalPath ||
      actionRoot.platform !== input.profile.platform) {
      throw new TypeError(
        `Action context root '${profileRoot.rootId}' does not match the Permission Profile.`,
      );
    }
  }

  return Object.freeze({ workspace, actor, environment });
}

function isCanonicalWorkspace(
  workspace: CanonicalWorkspaceIdentityInput | CanonicalWorkspaceIdentity,
): workspace is CanonicalWorkspaceIdentity {
  return workspace.roots.length > 0 && "canonicalPath" in workspace.roots[0]!;
}
