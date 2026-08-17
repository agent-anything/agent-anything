import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeEventPublisher } from "./RuntimeEvent.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./RuntimeEvent.js";
import type {
  ContextProjectionCompletedRuntimeEventPayload,
  ControllerFinishedRuntimeEventPayload,
} from "./RuntimeEventPayload.js";
import { RuntimeEventStream } from "./RuntimeEventStream.js";

describe("RuntimeEventStream", () => {
  it("materializes one bounded Run-scoped snapshot before fan-out", () => {
    const first: RuntimeEvent[] = [];
    const second: RuntimeEvent[] = [];
    const stream = createStream([
      { publish: (event) => first.push(event) },
      { publish: (event) => second.push(event) },
    ]);

    const event = stream.emit("controller.finished", {
      turnId: "turn-1",
      iteration: 1,
      status: "decided",
      code: null,
      decisionKind: "advance",
      rawModelOutput: "must-not-escape",
    } as ControllerFinishedRuntimeEventPayload);

    expect(event).toEqual({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "run-1:runtime-event:1",
      runId: "run-1",
      taskId: "task-1",
      sequence: 1,
      name: "controller.finished",
      occurredAt: NOW,
      payload: {
        turnId: "turn-1",
        iteration: 1,
        status: "decided",
        code: null,
        decisionKind: "advance",
      },
    });
    expect(first[0]).toBe(event);
    expect(second[0]).toBe(event);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(event.payload).not.toHaveProperty("rawModelOutput");
  });

  it("copies nested lists and isolates one publisher failure from the next", () => {
    const lowerResultRefs = ["action-settlement-1"];
    const delivered: RuntimeEvent[] = [];
    const stream = createStream([
      {
        publish(event) {
          Object.defineProperty(event.payload, "productTrace", { value: "forbidden" });
        },
      },
      { publish: (event) => delivered.push(event) },
    ]);

    const event = stream.emit("operation.finished", {
      invocationId: "operation-invocation-1",
      status: "succeeded",
      code: null,
      resultId: "operation-result-1",
      lowerResultRefs,
    });
    lowerResultRefs[0] = "mutated";

    expect(delivered).toEqual([event]);
    expect(event.payload.lowerResultRefs).toEqual(["action-settlement-1"]);
    expect(Object.isFrozen(event.payload.lowerResultRefs)).toBe(true);
  });

  it("allocates one monotonic sequence and de-duplicates publisher identity", () => {
    const events: RuntimeEvent[] = [];
    const publisher: RuntimeEventPublisher = {
      publish(event) {
        events.push(event);
      },
    };
    const stream = createStream([publisher, publisher]);

    stream.emit("run.started", { status: "running", activeAgentId: "agent-1" });
    stream.emit("controller.started", { turnId: "turn-1", iteration: 1 });

    expect(events.map((event) => [event.id, event.sequence])).toEqual([
      ["run-1:runtime-event:1", 1],
      ["run-1:runtime-event:2", 2],
    ]);
  });

  it("snapshots a payload-free Context transition trace record", () => {
    const events: RuntimeEvent[] = [];
    const stream = createStream([{ publish: (event) => events.push(event) }]);

    stream.emit("context.transition.committed", {
      transitionId: "transition-1",
      activeContextId: "context-1",
      baseVersion: 0,
      committedVersion: 1,
      proposerOwner: "agent-core",
      proposerKind: "run_execution",
      causeKind: "run_initialization",
      causeId: "run-1",
      correlationId: "run-1",
      operationKinds: ["add"],
    });

    expect(events[0]?.payload).toEqual({
      transitionId: "transition-1",
      activeContextId: "context-1",
      baseVersion: 0,
      committedVersion: 1,
      proposerOwner: "agent-core",
      proposerKind: "run_execution",
      causeKind: "run_initialization",
      causeId: "run-1",
      correlationId: "run-1",
      operationKinds: ["add"],
    });
    expect(events[0]?.payload).not.toHaveProperty("contributions");
  });

  it("publishes only the bounded Context Manifest summary", () => {
    const events: RuntimeEvent[] = [];
    const stream = createStream([{ publish: (event) => events.push(event) }]);

    stream.emit("context.projection.completed", {
      ...contextProjectionPayload(),
      manifestRecords: [{ payload: "must-not-escape" }],
    } as ContextProjectionCompletedRuntimeEventPayload);

    expect(events[0]?.payload).toEqual(contextProjectionPayload());
    expect(events[0]?.payload).not.toHaveProperty("manifestRecords");
  });
});

function contextProjectionPayload(): ContextProjectionCompletedRuntimeEventPayload {
  return {
    manifestId: "manifest-1",
    projectionId: "projection-1",
    requestId: "request-1",
    activeContextId: "context-1",
    activeContextVersion: 2,
    profileId: "profile-1",
    profileRevision: "1",
    policyId: "policy-1",
    policyRevision: "1",
    estimatorId: "estimator-1",
    estimatorRevision: "1",
    accountingUnit: "bytes",
    budgetMaximum: 1_024,
    consideredItemCount: 4,
    projectedItemCount: 2,
    projectedAmount: 512,
    includedCount: 1,
    transformedCount: 1,
    referencedCount: 0,
    omittedCount: 1,
    rejectedCount: 1,
    blockedCount: 0,
    outcome: "projected",
    code: null,
  };
}

function createStream(
  publishers: readonly RuntimeEventPublisher[],
): RuntimeEventStream {
  return new RuntimeEventStream({
    runId: "run-1",
    taskId: "task-1",
    now: () => NOW,
    createEventId: ({ runId, sequence }) => `${runId}:runtime-event:${sequence}`,
    publishers,
  });
}

const NOW = "2026-08-13T00:00:00.000Z";
