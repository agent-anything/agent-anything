import { describe, expect, it } from "vitest";
import {
  createBlockedRunResult,
  createSucceededRunResult,
} from "../runner/index.js";
import type { HostEventSink, HostSessionBlockedEvent } from "./HostEvent.js";
import { createHostEvent, mapRuntimeEventToHostEvent } from "./HostEvent.js";

describe("HostEvent", () => {
  it("creates serializable Host events with session ordering fields", () => {
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
          runId: "run-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          metadata: {},
        },
      },
    });

    expect(event).toMatchObject({
      name: "host.session.started",
      sessionId: "session-1",
      sequence: 1,
    });
  });

  it("maps Runtime events without changing the authoritative payload", () => {
    const runtimeEvent = {
      id: "runtime-event-1",
      name: "tool.started" as const,
      taskId: "task-1",
      sequence: 3,
      timestamp: "2026-06-15T00:00:00.000Z",
      payload: { actionId: "action-1", toolName: "workspace.read" },
    };
    const event = mapRuntimeEventToHostEvent({
      sessionId: "session-1",
      runtimeEvent,
    });

    expect(event.payload.runtimeEvent).toBe(runtimeEvent);
    expect(event.sequence).toBe(3);
  });

  it("carries the blocked RunResult rather than reconstructing a Host error", () => {
    const runResult = createBlockedRunResult(
      { runId: "run-1", taskId: "task-1" },
      "policy_denied",
    );
    const event: HostSessionBlockedEvent = createHostEvent({
      name: "host.session.blocked",
      sessionId: "session-1",
      taskId: "task-1",
      sequence: 4,
      timestamp: "2026-06-15T00:00:00.000Z",
      payload: { runResult },
    });

    expect(event.payload.runResult).toBe(runResult);
    expect(event.payload.runResult.code).toBe("policy_denied");
  });

  it("publishes succeeded output through runResult vocabulary", async () => {
    const runResult = createSucceededRunResult<{ ok: true }>(
      { runId: "run-1", taskId: "task-1" },
      { ok: true },
    );
    const names: string[] = [];
    const sink: HostEventSink<{ ok: true }> = (event) => {
      names.push(event.name);
    };

    await sink(createHostEvent({
      name: "host.output.produced",
      sessionId: "session-1",
      taskId: "task-1",
      sequence: 5,
      timestamp: "2026-06-15T00:00:00.000Z",
      payload: { runResult },
    }));

    expect(names).toEqual(["host.output.produced"]);
  });
});
