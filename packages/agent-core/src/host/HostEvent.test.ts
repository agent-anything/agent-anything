import { describe, expect, it } from "vitest";
import type { HostEventSink, HostSessionBlockedEvent } from "./HostEvent.js";
import { createHostEvent, mapRuntimeEventToHostEvent } from "./HostEvent.js";

describe("HostEvent", () => {
  it("creates serializable host events with session ordering fields", () => {
    const event = createHostEvent({
      id: "host-event-1",
      name: "host.session.started",
      sessionId: "session-1",
      taskId: "task-1",
      sequence: 1,
      timestamp: "2026-06-15T00:00:00.000Z",
      payload: {
        state: {
          sessionId: "session-1",
          status: "running",
          taskId: "task-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          metadata: {},
        },
      },
    });

    expect(event.name).toBe("host.session.started");
    expect(event.sessionId).toBe("session-1");
    expect(event.sequence).toBe(1);
  });

  it("maps runtime events into host runtime events without changing runtime event payload", () => {
    const event = mapRuntimeEventToHostEvent({
      sessionId: "session-1",
      runtimeEvent: {
        id: "runtime-event-1",
        name: "tool.started",
        taskId: "task-1",
        sequence: 3,
        timestamp: "2026-06-15T00:00:00.000Z",
        payload: {
          toolName: "dns.lookup",
        },
      },
    });

    expect(event.name).toBe("host.runtime.event");
    expect(event.id).toBe("host_runtime-event-1");
    expect(event.payload.runtimeEvent.name).toBe("tool.started");
    expect(event.sequence).toBe(3);
  });

  it("represents blocked as its own terminal host event", () => {
    const event: HostSessionBlockedEvent = createHostEvent({
      name: "host.session.blocked",
      sessionId: "session-1",
      taskId: "task-1",
      sequence: 4,
      timestamp: "2026-06-15T00:00:00.000Z",
      payload: {
        runtimeResult: {
          taskId: "task-1",
          status: "blocked",
          output: null,
          outputSpec: {
            format: "json",
            metadata: {},
          },
          evidenceRefs: [],
          artifactRefs: [],
          errors: [
            {
              code: "permission_denied",
              message: "Permission denied.",
              metadata: {},
            },
          ],
          metadata: {},
        },
      },
    });

    expect(event.name).toBe("host.session.blocked");
    expect(event.payload.runtimeResult.status).toBe("blocked");
  });

  it("can be consumed through a host event sink", async () => {
    const names: string[] = [];
    const sink: HostEventSink = (event) => {
      names.push(event.name);
    };

    await sink(createHostEvent({
      name: "host.output.produced",
      sessionId: "session-1",
      taskId: "task-1",
      sequence: 5,
      timestamp: "2026-06-15T00:00:00.000Z",
      payload: {
        runtimeResult: {
          taskId: "task-1",
          status: "succeeded",
          output: { ok: true },
          outputSpec: {
            format: "json",
            metadata: {},
          },
          evidenceRefs: [],
          artifactRefs: [],
          errors: [],
          metadata: {},
        },
      },
    }));

    expect(names).toEqual(["host.output.produced"]);
  });
});
