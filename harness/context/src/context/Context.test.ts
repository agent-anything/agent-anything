import type { ContextObservation } from "./Context.js";
import type { AgentTask } from "@agent-anything/agent-core/task";
import { describe, expect, it } from "vitest";
import {
  applyContextUpdate,
  createInitialContext,
} from "./Context.js";

interface TestObservation extends ContextObservation {
  readonly kind: "test_result";
  readonly value: string;
}

describe("Context transitions", () => {
  it("creates invocation-local Context without retaining task identity as state ownership", () => {
    const context = createInitialContext<TestObservation>(createTask());

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
    const initial = createInitialContext<TestObservation>(createTask());
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
    expect(Object.isFrozen(updated.observations[0]?.metadata)).toBe(true);
  });

  it("rejects duplicate Observation identities across updates", () => {
    const observation = createObservation();
    const context = applyContextUpdate(
      createInitialContext<TestObservation>(createTask()),
      { observations: [observation] },
    );

    expect(() =>
      applyContextUpdate(context, { observations: [observation] }),
    ).toThrow("Observation id 'observation-1' is duplicated");
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

function createObservation(): TestObservation {
  return {
    id: "observation-1",
    runId: "run-1",
    actionId: "action-1",
    kind: "test_result",
    value: "accepted",
    createdAt: "2026-07-13T00:00:01.000Z",
    metadata: {},
  };
}
