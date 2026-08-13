import type { IdentityRef } from "@agent-anything/agent-core/run";
import type { WorkspaceIdentity } from "@agent-anything/workspace/identity";
import type { WorkspaceSelection } from "@agent-anything/workspace/selection";
import { describe, expect, it } from "vitest";
import {
  createStaticHostIdentityResolver,
  createStaticHostWorkspaceResolver,
  HostContextResolutionError,
  resolveHostRunContext,
  type HostIdentityResolver,
  type HostWorkspaceResolver,
} from "./HostContext.js";

describe("Host Run context resolution", () => {
  it("resolves and snapshots one referenced Run Workspace and Identity", async () => {
    const workspace = runWorkspace();
    const identity = userIdentity();
    const result = await resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(workspace),
      identityResolver: createStaticHostIdentityResolver(identity),
    });

    workspace.primary.name = "mutated";
    workspace.additional.push(workspaceContext("late"));
    identity.displayName = "mutated";

    expect(result.workspace).toMatchObject({
      primary: { id: "workspace-primary", name: "Primary" },
      additional: [{ id: "workspace-docs" }],
    });
    expect(result.identity).toMatchObject({
      id: "user-1",
      kind: "user",
      displayName: "User One",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.workspace?.additional)).toBe(true);
  });

  it("derives both resolver inputs from one invocation correlation snapshot", async () => {
    const metadata = { source: "test" };
    let workspaceInput: unknown;
    let identityInput: unknown;

    await resolveHostRunContext({
      ...resolutionInput(),
      metadata,
      workspaceResolver: {
        async resolve(input) {
          workspaceInput = input;
          return runWorkspace();
        },
      },
      identityResolver: {
        async resolve(input) {
          identityInput = input;
          return userIdentity();
        },
      },
    });

    metadata.source = "mutated";

    expect(workspaceInput).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      taskId: "task-1",
      metadata: { source: "test" },
    });
    expect(identityInput).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      taskId: "task-1",
      metadata: { source: "test" },
    });
    expect(
      (workspaceInput as { metadata: object }).metadata,
    ).toBe((identityInput as { metadata: object }).metadata);
    expect(Object.isFrozen(workspaceInput)).toBe(true);
    expect(Object.isFrozen(identityInput)).toBe(true);
  });

  it("preserves explicit no-Workspace and anonymous Identity", async () => {
    const result = await resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(null),
      identityResolver: createStaticHostIdentityResolver(anonymousIdentity()),
      workspaceSelection: { kind: "none" },
      identitySelection: { kind: "anonymous" },
      workspaceRequirement: "optional",
    });

    expect(result.workspace).toBeNull();
    expect(result.identity.kind).toBe("anonymous");
  });

  it("rejects explicit no-Workspace for a required Workspace Run", async () => {
    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(null),
      identityResolver: createStaticHostIdentityResolver(anonymousIdentity()),
      workspaceSelection: { kind: "none" },
      identitySelection: { kind: "anonymous" },
      workspaceRequirement: "required",
    })).rejects.toMatchObject({
      code: "host_workspace_required",
    });
  });

  it("does not convert Workspace resolver failure into an unknown Workspace", async () => {
    const resolver: HostWorkspaceResolver = {
      async resolve() {
        throw new Error("unavailable");
      },
    };

    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: resolver,
      identityResolver: createStaticHostIdentityResolver(userIdentity()),
    })).rejects.toMatchObject({
      code: "host_workspace_resolution_failed",
    });
  });

  it("does not convert Identity resolver failure into anonymous Identity", async () => {
    const resolver: HostIdentityResolver = {
      async resolve() {
        throw new Error("unavailable");
      },
    };

    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(runWorkspace()),
      identityResolver: resolver,
    })).rejects.toMatchObject({
      code: "host_identity_resolution_failed",
    });
  });

  it("rejects malformed resolver output", async () => {
    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: {
        async resolve() {
          return { primary: null, additional: [] } as unknown as WorkspaceSelection;
        },
      },
      identityResolver: createStaticHostIdentityResolver(userIdentity()),
    })).rejects.toMatchObject({
      code: "host_workspace_resolution_invalid",
    });
  });

  it("rejects resolver output that contradicts explicit selections", async () => {
    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(runWorkspace()),
      identityResolver: createStaticHostIdentityResolver(userIdentity()),
      workspaceSelection: { kind: "none" },
      workspaceRequirement: "optional",
    })).rejects.toMatchObject({
      code: "host_workspace_resolution_invalid",
    });

    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(runWorkspace()),
      identityResolver: createStaticHostIdentityResolver(anonymousIdentity()),
    })).rejects.toMatchObject({
      code: "host_identity_resolution_invalid",
    });
  });

  it("preserves an explicit trusted identity rejection", async () => {
    const resolver: HostIdentityResolver = {
      async resolve() {
        throw new HostContextResolutionError(
          "host_identity_rejected",
          "Identity is not admitted.",
        );
      },
    };

    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(runWorkspace()),
      identityResolver: resolver,
    })).rejects.toMatchObject({
      code: "host_identity_rejected",
    });
  });

  it("attributes malformed Identity acquisition input to the Identity owner", async () => {
    await expect(resolveHostRunContext({
      ...resolutionInput(),
      workspaceResolver: createStaticHostWorkspaceResolver(runWorkspace()),
      identityResolver: createStaticHostIdentityResolver(userIdentity()),
      identitySelection: null as never,
    })).rejects.toMatchObject({
      code: "host_identity_selection_invalid",
    });
  });

  it("rejects malformed shared invocation correlation as Host context input", async () => {
    await expect(resolveHostRunContext({
      ...resolutionInput(),
      runId: " ",
      workspaceResolver: createStaticHostWorkspaceResolver(runWorkspace()),
      identityResolver: createStaticHostIdentityResolver(userIdentity()),
    })).rejects.toMatchObject({
      code: "host_context_input_invalid",
    });

    await expect(
      resolveHostRunContext(null as never),
    ).rejects.toMatchObject({
      code: "host_context_input_invalid",
    });
  });
});

function resolutionInput() {
  return {
    sessionId: "session-1",
    runId: "run-1",
    taskId: "task-1",
    metadata: {},
    workspaceSelection: {
      kind: "references" as const,
      primaryRef: "profile-primary",
      additionalRefs: ["profile-docs"],
    },
    identitySelection: {
      kind: "reference" as const,
      identityRef: "account-1",
    },
    workspaceRequirement: "required" as const,
  };
}

function runWorkspace(): {
  primary: WorkspaceIdentity & { name: string };
  additional: WorkspaceIdentity[];
} {
  return {
    primary: workspaceContext("primary"),
    additional: [workspaceContext("docs")],
  };
}

function workspaceContext(id: string): WorkspaceIdentity & { name: string } {
  return {
    id: `workspace-${id}`,
    name: id[0]!.toUpperCase() + id.slice(1),
    rootRef: `workspace://${id}`,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}

function userIdentity(): IdentityRef & { displayName: string } {
  return {
    id: "user-1",
    kind: "user",
    displayName: "User One",
    metadata: {},
  };
}

function anonymousIdentity(): IdentityRef {
  return {
    id: "anonymous",
    kind: "anonymous",
    displayName: "Anonymous",
    metadata: {},
  };
}
