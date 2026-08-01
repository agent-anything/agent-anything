import { describe, expect, it } from "vitest";
import {
  createHelarcTask,
  createTrustedHelarcRunWorkspace,
  HELARC_TASK_KIND,
} from "./index.js";

describe("createHelarcTask", () => {
  it("creates an independent Task and trusted primary Run Workspace", () => {
    const result = createHelarcTask({
      taskId: "task-1",
      prompt: "  update the README  ",
      createdAt: "2026-06-26T00:00:00.000Z",
      workspace: {
        id: "workspace-1",
        name: "agent-anything",
        rootRef: "D:/projects/agent-anything",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.task).toMatchObject({
      id: "task-1",
      kind: HELARC_TASK_KIND,
      input: { prompt: "update the README" },
    });
    expect(result.task).not.toHaveProperty("workspaceScope");
    expect(result.workspace.primary).toMatchObject({
      id: "workspace-1",
      name: "agent-anything",
      rootRef: "D:/projects/agent-anything",
      trustState: "trusted",
      source: "helarc-desktop",
    });
    expect(result.workspace.additional).toEqual([]);
  });

  it("rejects empty task text", () => {
    const result = createHelarcTask({
      taskId: "task-1",
      prompt: "   ",
      createdAt: "2026-06-26T00:00:00.000Z",
      workspace: {
        id: "workspace-1",
        name: "agent-anything",
        rootRef: "D:/projects/agent-anything",
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "task_prompt_required",
        message: "Task prompt is required.",
      },
    });
  });

  it("rejects missing workspace authority", () => {
    const result = createTrustedHelarcRunWorkspace({
      id: "workspace-1",
      name: "agent-anything",
      rootRef: " ",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "workspace_root_required",
        message: "Workspace root is required.",
      },
    });
  });
});
