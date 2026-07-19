import { describe, expect, it } from "vitest";
import {
  createHostIdentityProvider,
  createHostWorkspaceResolver,
} from "./HostContext.js";

describe("HostContext", () => {
  it("resolves host-provided workspace context", async () => {
    const resolver = createHostWorkspaceResolver({
      workspace: {
        id: "workspace-1",
        name: "Workspace",
        rootRef: "file:///workspace",
        trustState: "trusted",
        source: "desktop",
        policyRefs: ["policy-1"],
        metadata: {
          projectKind: "typescript",
        },
      },
    });

    await expect(resolver.resolve({
      taskId: "task-1",
      metadata: {},
    })).resolves.toMatchObject({
      id: "workspace-1",
      trustState: "trusted",
      source: "desktop",
    });
  });

  it("represents missing workspace context explicitly", async () => {
    const resolver = createHostWorkspaceResolver({
      source: "cli",
    });

    await expect(resolver.resolve({
      taskId: "task-1",
      cwd: null,
      metadata: {},
    })).resolves.toMatchObject({
      id: "workspace_unknown",
      rootRef: null,
      trustState: "unknown",
      source: "cli",
    });
  });

  it("resolves host-provided identity context", async () => {
    const provider = createHostIdentityProvider({
      identity: {
        id: "user-1",
        kind: "user",
        displayName: "User One",
        metadata: {
          role: "developer",
        },
      },
    });

    await expect(provider.resolve({
      taskId: "task-1",
      metadata: {},
    })).resolves.toMatchObject({
      id: "user-1",
      kind: "user",
      displayName: "User One",
    });
  });

  it("represents missing identity context as anonymous", async () => {
    const provider = createHostIdentityProvider({
      source: "desktop",
    });

    await expect(provider.resolve({
      taskId: "task-1",
      metadata: {},
    })).resolves.toMatchObject({
      id: "anonymous",
      kind: "anonymous",
      displayName: "Anonymous",
      metadata: {
        source: "desktop",
      },
    });
  });
});
