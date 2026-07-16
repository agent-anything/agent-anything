import { describe, expect, it } from "vitest";
import type { ManagedPermissionConstraints } from "@agent-anything/governance";
import { resolvePermissionProfile } from "@agent-anything/permission";
import { snapshotRunActionContext, type RunActionContextInput } from "./RunActionContext.js";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

describe("RunActionContext", () => {
  it("snapshots canonical physical identities that agree with the resolved Run", () => {
    const context = actionContext();
    const snapshot = snapshotRunActionContext({
      context,
      workspace: workspace(),
      identity: identity(),
      profile: profile(),
    });
    (context.workspace.roots[0] as { path: string }).path = "C:/changed";

    expect(snapshot.workspace.roots[0]).toMatchObject({
      rootId: "root-1",
      canonicalPath: "C:/workspace",
      resolvedPath: "C:/workspace",
      resolutionFingerprint: SHA_A,
    });
    expect(Object.isFrozen(snapshot.workspace.roots)).toBe(true);
  });

  it("rejects workspace, actor, environment, or root identity disagreement", () => {
    expect(() => snapshotRunActionContext({
      context: {
        ...actionContext(),
        workspace: { ...actionContext().workspace, trustState: "restricted" },
      },
      workspace: workspace(),
      identity: identity(),
      profile: profile(),
    })).toThrow("workspace identity does not match");

    expect(() => snapshotRunActionContext({
      context: {
        ...actionContext(),
        actor: { identityId: "other-user", kind: "user" },
      },
      workspace: workspace(),
      identity: identity(),
      profile: profile(),
    })).toThrow("actor identity does not match");

    expect(() => snapshotRunActionContext({
      context: {
        ...actionContext(),
        environment: { ...actionContext().environment, environmentId: "other" },
      },
      workspace: workspace(),
      identity: identity(),
      profile: profile(),
    })).toThrow("environment does not match");
  });
});

function actionContext(): RunActionContextInput {
  return {
    workspace: {
      workspaceId: "workspace-1",
      trustState: "trusted",
      roots: [{
        rootId: "root-1",
        platform: "win32",
        path: "C:/workspace",
        resolvedPath: "C:/workspace",
        resolutionFingerprint: SHA_A,
      }],
    },
    actor: { identityId: "user-1", kind: "user" },
    environment: {
      environmentId: "local",
      platform: "win32",
      configurationFingerprint: SHA_B,
    },
  };
}

function workspace() {
  return {
    id: "workspace-1",
    name: "Workspace",
    rootRef: "workspace://root-1",
    trustState: "trusted" as const,
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

function identity() {
  return {
    id: "user-1",
    kind: "user" as const,
    displayName: "User",
    metadata: {},
  };
}

function profile() {
  return resolvePermissionProfile({
    profileId: ":read-only",
    profiles: [],
    environment: {
      environmentId: "local",
      platform: "win32",
      workspaceRoots: [{ rootId: "root-1", path: "C:/workspace" }],
    },
    managedConstraints: constraints(),
  });
}

function constraints(): ManagedPermissionConstraints {
  return {
    constraintSetId: "managed-1",
    selectableProfiles: { allowedProfileIds: null, deniedProfileIds: [] },
    fileSystem: [],
    network: { enabled: null, allowedDomains: [], deniedDomains: [] },
    allowUnenforcedExecution: false,
  };
}
