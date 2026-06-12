import { describe, expect, it } from "vitest";
import { FakeWorkspaceResolver } from "../testing/index.js";
import { createDefaultWorkspaceResolver } from "./WorkspaceResolver.js";

describe("WorkspaceResolver", () => {
  it("resolves a default local workspace", async () => {
    const resolver = createDefaultWorkspaceResolver();

    await expect(resolver.resolve({
      taskId: "task_001",
      cwd: "D:/projects/example",
      metadata: {},
    })).resolves.toMatchObject({
      id: "workspace_local",
      name: "Local workspace",
      rootRef: "D:/projects/example",
      policyRefs: [],
    });
  });

  it("records fake workspace resolver inputs", async () => {
    const resolver = new FakeWorkspaceResolver({
      id: "workspace_001",
      name: "Test workspace",
      rootRef: "D:/projects/example",
      policyRefs: ["policy_001"],
      metadata: {},
    });

    await resolver.resolve({
      taskId: "task_001",
      cwd: "D:/projects/example",
      metadata: {},
    });

    expect(resolver.requests).toHaveLength(1);
    expect(resolver.requests[0]).toMatchObject({
      taskId: "task_001",
    });
  });

  it("can simulate workspace resolver failure", async () => {
    const resolver = new FakeWorkspaceResolver(() => {
      throw new Error("Workspace unavailable.");
    });

    await expect(resolver.resolve({
      taskId: "task_001",
      metadata: {},
    })).rejects.toThrow("Workspace unavailable.");
  });
});
