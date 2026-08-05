import { describe, expect, it } from "vitest";
import type { AgentTask } from "@agent-anything/agent-core/task";
import type { ActionRejectedObservation } from "../observation/index.js";
import {
  applyContextUpdate,
  createInitialContext,
  projectContext,
} from "./Context.js";

describe("Context transitions", () => {
  it("creates invocation-local Context without retaining task identity as state ownership", () => {
    const context = createInitialContext(createTask());

    expect(context).toEqual({
      messages: [],
      observations: [],
      evidenceRefs: [],
      metadata: {
        source: "test",
        taskKind: "test.agent.run",
        createdAt: "2026-07-13T00:00:00.000Z",
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.messages)).toBe(true);
  });

  it("applies an immutable append-only update and deduplicates evidence references", () => {
    const initial = createInitialContext(createTask());
    const observation = createObservation();
    const updated = applyContextUpdate(initial, {
      messages: [{
        id: "message-1",
        role: "assistant",
        content: "Inspected the workspace.",
        metadata: {},
      }],
      observations: [observation],
      evidenceRefs: ["evidence-1", "evidence-1"],
      metadata: { iteration: 1 },
    });

    expect(initial.messages).toEqual([]);
    expect(initial.observations).toEqual([]);
    expect(initial.evidenceRefs).toEqual([]);
    expect(updated.messages).toHaveLength(1);
    expect(updated.observations).toEqual([observation]);
    expect(updated.evidenceRefs).toEqual(["evidence-1"]);
    expect(updated.metadata).toMatchObject({ source: "test", iteration: 1 });
    expect(Object.isFrozen(updated.observations)).toBe(true);
  });

  it("projects only Context-owned state through one immutable value", () => {
    const context = applyContextUpdate(createInitialContext(createTask()), {
      observations: [createObservation()],
    });
    const projection = projectContext(context);

    expect(projection.observations).toEqual(context.observations);
    expect(projection.metadata).toEqual(context.metadata);
    expect(Object.isFrozen(projection)).toBe(true);
  });
});

function createTask(): AgentTask {
  return {
    id: "task-1",
    kind: "test.agent.run",
    input: {},
    createdAt: "2026-07-13T00:00:00.000Z",
    metadata: { source: "test" },
  };
}

function createObservation(): ActionRejectedObservation {
  return {
    id: "observation-1",
    runId: "run-1",
    actionId: "action-1",
    kind: "action_rejected",
    code: "action_unsupported",
    message: "Action is not supported.",
    createdAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}
