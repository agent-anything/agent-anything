import type { Action } from "@agent-anything/agent-core/action";
import type {
  ActionRunItem,
  RunInput,
  RunResult,
} from "@agent-anything/agent-core/run";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as coreApi from "../index.js";
import { createSucceededRunResult } from "./index.js";

describe("agent-core semantic public API", () => {
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

  it("does not expose concrete Runtime implementations", () => {
    expect(coreApi).not.toHaveProperty("Runner");
    expect(coreApi).not.toHaveProperty("ProviderBackedController");
    expect(coreApi).not.toHaveProperty("RetryExecutor");
    expect(coreApi).not.toHaveProperty("StructuredOutputError");
  });
});
