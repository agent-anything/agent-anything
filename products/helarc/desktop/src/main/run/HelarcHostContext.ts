import {
  HostContextResolutionError,
  type HostIdentityResolutionInput,
  type HostIdentityResolver,
  type HostWorkspaceResolutionInput,
  type HostWorkspaceResolver,
} from "@agent-anything/host";
import type {
  HelarcThreadWorkspaceContext,
  HelarcThreadWorkspaceRef,
} from "@agent-anything/helarc";
import type { RunWorkspace, WorkspaceContext } from "@agent-anything/agent-core/run";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

export function createHelarcDesktopWorkspaceResolver(
  workspace: HelarcThreadWorkspaceContext,
): HostWorkspaceResolver {
  const selection = snapshotThreadWorkspace(workspace);

  return Object.freeze({
    async resolve(
      input: HostWorkspaceResolutionInput,
    ): Promise<RunWorkspace | null> {
      if (input.selection.kind === "none") {
        return null;
      }
      const expectedRefs = [
        selection.primary.profileId,
        ...selection.additional.map((candidate) => candidate.profileId),
      ];
      const actualRefs = [
        input.selection.primaryRef,
        ...input.selection.additionalRefs,
      ];
      if (
        expectedRefs.length !== actualRefs.length ||
        expectedRefs.some((reference, index) => reference !== actualRefs[index])
      ) {
        throw new HostContextResolutionError(
          "host_workspace_resolution_invalid",
          "Helarc Workspace selection does not match the prepared Thread context.",
        );
      }

      return Object.freeze({
        primary: await resolveWorkspaceContext(selection.primary),
        additional: Object.freeze(await Promise.all(
          selection.additional.map(resolveWorkspaceContext),
        )),
      });
    },
  });
}

export function createHelarcDesktopIdentityResolver(): HostIdentityResolver {
  return Object.freeze({
    async resolve(input: HostIdentityResolutionInput) {
      if (input.selection.kind !== "anonymous") {
        throw new HostContextResolutionError(
          "host_identity_rejected",
          "Helarc Desktop has no configured referenced Identity.",
        );
      }
      return Object.freeze({
        id: "helarc-anonymous",
        kind: "anonymous" as const,
        displayName: "Helarc user",
        metadata: Object.freeze({
          source: "helarc-desktop",
        }),
      });
    },
  });
}

async function resolveWorkspaceContext(
  reference: HelarcThreadWorkspaceRef,
): Promise<WorkspaceContext> {
  const lexicalPath = normalize(reference.path);
  if (!isAbsolute(lexicalPath)) {
    throw new HostContextResolutionError(
      "host_workspace_resolution_invalid",
      `Helarc Workspace profile '${reference.profileId}' has no absolute root.`,
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(lexicalPath);
    const rootStats = await stat(resolvedPath);
    if (!rootStats.isDirectory()) {
      throw new Error("Workspace root is not a directory.");
    }
  } catch {
    throw new HostContextResolutionError(
      "host_workspace_resolution_failed",
      `Helarc Workspace profile '${reference.profileId}' cannot be resolved.`,
    );
  }

  return Object.freeze({
    id: reference.profileId,
    name: reference.displayName,
    rootRef: resolvedPath,
    trustState: "trusted",
    source: "helarc-desktop.workspace-profile",
    policyRefs: Object.freeze([]),
    metadata: Object.freeze({
      profileId: reference.profileId,
    }),
  });
}

function snapshotThreadWorkspace(
  workspace: HelarcThreadWorkspaceContext,
): HelarcThreadWorkspaceContext {
  const primary = snapshotThreadWorkspaceRef(workspace.primary);
  const additional = workspace.additional.map(snapshotThreadWorkspaceRef);
  const profileIds = new Set([primary.profileId]);
  for (const candidate of additional) {
    if (profileIds.has(candidate.profileId)) {
      throw new TypeError(
        `Helarc Workspace profile '${candidate.profileId}' is duplicated.`,
      );
    }
    profileIds.add(candidate.profileId);
  }
  return Object.freeze({
    primary,
    additional: Object.freeze(additional),
  });
}

function snapshotThreadWorkspaceRef(
  workspace: HelarcThreadWorkspaceRef,
): HelarcThreadWorkspaceRef {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    typeof workspace.profileId !== "string" ||
    workspace.profileId.trim().length === 0 ||
    typeof workspace.displayName !== "string" ||
    workspace.displayName.trim().length === 0 ||
    typeof workspace.path !== "string" ||
    workspace.path.trim().length === 0
  ) {
    throw new TypeError("Helarc Thread Workspace reference is invalid.");
  }
  return Object.freeze({
    profileId: workspace.profileId,
    displayName: workspace.displayName,
    path: workspace.path,
  });
}
