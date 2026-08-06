import { describe, expect, it } from "vitest";
import {
  createHelarcTask,
  HELARC_TASK_KIND,
} from "./index.js";

describe("createHelarcTask", () => {
  it("creates an independent Task without Workspace ownership", () => {
    const result = createHelarcTask({
      taskId: "task-1",
      prompt: "  update the README  ",
      createdAt: "2026-06-26T00:00:00.000Z",
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
    expect(result).not.toHaveProperty("workspace");
  });

  it("rejects empty task text", () => {
    const result = createHelarcTask({
      taskId: "task-1",
      prompt: "   ",
      createdAt: "2026-06-26T00:00:00.000Z",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "task_prompt_required",
        message: "Task prompt is required.",
      },
    });
  });
});
