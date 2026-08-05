import type { Action } from "@agent-anything/agent-core/action";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { ActionRunItem, RunResult } from "./index.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as runApi from "./index.js";
import { createSucceededRunResult } from "./index.js";

describe("Agent Core Run public API", () => {
  it("exposes Action and Run contracts without the Runner implementation", () => {
    const action: Action = {
      id: "action-1",
      runId: "run-1",
      sequence: 1,
      kind: "tool",
      name: "codeAgent.readFile",
      input: { path: "README.md" },
      provenance: {
        modelItemId: "model-item-1",
        controllerIteration: 1,
      },
    };
    const item: ActionRunItem = {
      id: "item-1",
      runId: "run-1",
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: {},
      kind: "action",
      action,
    };
    const result = createSucceededRunResult(
      {
        runId: "run-1",
        taskId: "task-1",
        items: [item],
      },
      { summary: "done" },
    );

    expect(result.items).toEqual([item]);
    expect(result.status).toBe("succeeded");
    expectTypeOf(result).toMatchTypeOf<RunResult<{ summary: string }>>();
    expectTypeOf<RunInput>().toBeObject();
  });

  it("keeps Run semantics separate from Runner and Action Execution values", () => {
    expect(runApi).toHaveProperty("createSucceededRunResult");
    expect(runApi).not.toHaveProperty("Runner");
    expect(runApi).not.toHaveProperty("ActionEnforcementPipeline");
    expect(runApi).not.toHaveProperty("createSandboxExecutionGateway");
  });
});
