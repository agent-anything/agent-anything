import { describe, expect, it } from "vitest";
import type { WorkspaceContext } from "@agent-anything/governance";
import type { AgentTask } from "./AgentTask.js";
import type { TaskWorkspaceScope } from "./TaskWorkspaceScope.js";

describe("TaskWorkspaceScope", () => {
  it("allows a task to declare multiple named workspace roots", () => {
    const scope: TaskWorkspaceScope = {
      roots: {
        code: createWorkspace("workspace-code", "code-root"),
        docs: createWorkspace(
          "workspace-docs",
          "docs-root",
        ),
      },
      defaultRootName: "code",
    };
    const task: AgentTask = {
      id: "task-1",
      kind: "code.change",
      input: {},
      createdAt: "2026-06-20T00:00:00.000Z",
      metadata: {},
      workspaceScope: scope,
    };

    expect(Object.keys(task.workspaceScope?.roots ?? {})).toEqual([
      "code",
      "docs",
    ]);
    expect(task.workspaceScope?.defaultRootName).toBe("code");
  });

  it("allows tasks without filesystem workspace roots", () => {
    const task: AgentTask = {
      id: "task-2",
      kind: "network.diagnosis",
      input: {},
      createdAt: "2026-06-20T00:00:00.000Z",
      metadata: {},
    };

    expect(task.workspaceScope).toBeUndefined();
  });
});

function createWorkspace(id: string, rootRef: string): WorkspaceContext {
  return {
    id,
    name: id,
    rootRef,
    trustState: "trusted",
    source: "test",
    policyRefs: [],
    metadata: {},
  };
}
