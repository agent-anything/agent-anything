import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeEventPublisher } from "./RuntimeEvent.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./RuntimeEvent.js";
import type { ControllerFinishedRuntimeEventPayload } from "./RuntimeEventPayload.js";
import { RuntimeEventStream } from "./RuntimeEventStream.js";

const occurredAt = "2026-08-03T00:00:00.000Z";

describe("RuntimeEventStream", () => {
  it("materializes one Run-scoped event snapshot before fan-out", () => {
    const first: RuntimeEvent[] = [];
    const second: RuntimeEvent[] = [];
    const firstPublisher: RuntimeEventPublisher = {
      publish(event) {
        first.push(event);
      },
    };
    const secondPublisher: RuntimeEventPublisher = {
      publish(event) {
        second.push(event);
      },
    };
    const stream = createStream([firstPublisher, secondPublisher]);
    const event = stream.emit("controller.finished", {
      iteration: 1,
      status: "succeeded",
      code: null,
      decisionKind: "actions",
      controllerAction: "product-only-field",
    } as ControllerFinishedRuntimeEventPayload);

    expect(event).toEqual({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "run-1:runtime_event:1",
      runId: "run-1",
      taskId: "task-1",
      sequence: 1,
      name: "controller.finished",
      occurredAt,
      payload: {
        iteration: 1,
        status: "succeeded",
        code: null,
        decisionKind: "actions",
      },
    });
    expect(first[0]).toBe(event);
    expect(second[0]).toBe(event);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(event.payload).not.toHaveProperty("controllerAction");
  });

  it("deeply snapshots payloads and isolates publisher mutation failures", () => {
    const steps = [{ step: "Inspect", status: "in_progress" as const }];
    const first: RuntimeEvent[] = [];
    const second: RuntimeEvent[] = [];
    const stream = createStream([
      {
        publish(event) {
          first.push(event);
          Object.defineProperty(event.payload, "productTrace", {
            value: "not-allowed",
          });
        },
      },
      {
        publish(event) {
          second.push(event);
        },
      },
    ]);

    const event = stream.emit("plan.created", {
      plan: {
        id: "plan-1",
        version: 1,
        status: "active",
        steps,
      },
    });
    steps[0] = { step: "Mutated", status: "completed" };

    expect(first[0]).toBe(event);
    expect(second[0]).toBe(event);
    expect(event.payload.plan.steps).toEqual([
      { step: "Inspect", status: "in_progress" },
    ]);
    expect(Object.isFrozen(event.payload.plan)).toBe(true);
    expect(Object.isFrozen(event.payload.plan.steps)).toBe(true);
    expect(Object.isFrozen(event.payload.plan.steps[0])).toBe(true);
  });

  it("allocates one monotonic sequence and delivers a duplicate publisher once", () => {
    const events: RuntimeEvent[] = [];
    const publisher: RuntimeEventPublisher = {
      publish(event) {
        events.push(event);
      },
    };
    const stream = createStream([publisher, publisher]);

    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    });
    stream.emit("controller.started", { iteration: 1 });

    expect(events.map((event) => [event.id, event.sequence])).toEqual([
      ["run-1:runtime_event:1", 1],
      ["run-1:runtime_event:2", 2],
    ]);
  });
});

function createStream(
  publishers: readonly RuntimeEventPublisher[],
): RuntimeEventStream {
  return new RuntimeEventStream({
    runId: "run-1",
    taskId: "task-1",
    now: () => occurredAt,
    createEventId: ({ runId, sequence }) =>
      `${runId}:runtime_event:${sequence}`,
    publishers,
  });
}
