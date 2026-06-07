import { describe, expect, it } from "vitest";
import type { AgentTask } from "../task/index.js";
import { InMemoryContextManager } from "./InMemoryContextManager.js";
import type { Observation } from "./Observation.js";

describe("InMemoryContextManager", () => {
  it("creates an initial context snapshot from a task", async () => {
    const manager = new InMemoryContextManager();

    const snapshot = await manager.createInitial(createTask());

    expect(snapshot).toEqual({
      taskId: "task_001",
      messages: [],
      observations: [],
      evidenceRefs: [],
      metadata: {
        source: "test",
        taskKind: "net-doctor.diagnose",
        createdAt: "2026-06-07T00:00:00.000Z",
      },
    });
  });

  it("applies one context update", async () => {
    const manager = new InMemoryContextManager();
    await manager.createInitial(createTask());

    const snapshot = await manager.applyUpdate({
      taskId: "task_001",
      observations: [createObservation("observation_001")],
      evidenceRefs: ["evidence_001"],
      messages: [
        {
          id: "message_001",
          role: "runtime",
          content: "DNS lookup completed.",
          metadata: {},
        },
      ],
      metadata: {
        updatedBy: "test",
      },
    });

    expect(snapshot.observations.map((item) => item.id)).toEqual([
      "observation_001",
    ]);
    expect(snapshot.evidenceRefs).toEqual(["evidence_001"]);
    expect(snapshot.messages.map((item) => item.id)).toEqual(["message_001"]);
    expect(snapshot.metadata).toMatchObject({
      source: "test",
      updatedBy: "test",
    });
  });

  it("applies multiple updates without replacing unrelated fields", async () => {
    const manager = new InMemoryContextManager();
    await manager.createInitial(createTask());

    await manager.applyUpdate({
      taskId: "task_001",
      observations: [createObservation("observation_001")],
      evidenceRefs: ["evidence_001"],
    });
    const snapshot = await manager.applyUpdate({
      taskId: "task_001",
      observations: [createObservation("observation_002")],
      evidenceRefs: ["evidence_001", "evidence_002"],
    });

    expect(snapshot.observations.map((item) => item.id)).toEqual([
      "observation_001",
      "observation_002",
    ]);
    expect(snapshot.evidenceRefs).toEqual(["evidence_001", "evidence_002"]);
  });

  it("returns defensive copies of snapshots", async () => {
    const manager = new InMemoryContextManager();
    const snapshot = await manager.createInitial(createTask());
    snapshot.observations.push(createObservation("mutated"));
    snapshot.metadata.source = "mutated";

    const storedSnapshot = await manager.getSnapshot("task_001");

    expect(storedSnapshot.observations).toEqual([]);
    expect(storedSnapshot.metadata.source).toBe("test");
  });

  it("rejects updates for an unknown task", async () => {
    const manager = new InMemoryContextManager();

    await expect(
      manager.applyUpdate({
        taskId: "missing_task",
        observations: [createObservation("observation_001")],
      }),
    ).rejects.toThrow("Context snapshot does not exist for task: missing_task");
  });
});

function createTask(): AgentTask {
  return {
    id: "task_001",
    kind: "net-doctor.diagnose",
    input: {},
    createdAt: "2026-06-07T00:00:00.000Z",
    metadata: {
      source: "test",
    },
  };
}

function createObservation(id: string): Observation {
  return {
    id,
    source: {
      kind: "toolResult",
      id: "tool_call_001",
      metadata: {},
    },
    summary: "DNS lookup completed.",
    toolResultRef: "tool_call_001",
    evidenceRefs: ["evidence_001"],
    metadata: {},
  };
}
