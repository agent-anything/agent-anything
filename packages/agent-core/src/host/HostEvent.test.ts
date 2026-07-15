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

  it("maps Runtime events through an immutable allowlisted payload", () => {
    const runtimeEvent = {
      id: "runtime-event-1",
      name: "tool.started" as const,
      taskId: "task-1",
      sequence: 3,
      timestamp: "2026-06-15T00:00:00.000Z",
      payload: {
        actionId: "action-1",
        toolName: "workspace.read",
        rawInput: { path: "secret.txt" },
      },
    };
    const event = mapRuntimeEventToHostEvent({
      sessionId: "session-1",
      runtimeEvent,
    });

    expect(event.payload.runtimeEvent).not.toBe(runtimeEvent);
    expect(event.payload.runtimeEvent.payload).toEqual({
      actionId: "action-1",
      toolName: "workspace.read",
    });
    expect(Object.isFrozen(event.payload.runtimeEvent)).toBe(true);
    expect(Object.isFrozen(event.payload.runtimeEvent.payload)).toBe(true);
    expect(event.sequence).toBe(3);
  });

  it("projects only safe Retry cancellation attribution fields", () => {
    const event = mapRuntimeEventToHostEvent({
      sessionId: "session-1",
      runtimeEvent: {
        id: "runtime-event-retry-cancelled",
        name: "retry.cancelled",
        taskId: "task-1",
        sequence: 4,
        timestamp: "2026-06-15T00:00:00.000Z",
        payload: {
          type: "retry_cancelled",
          runId: "run-1",
          operationId: "operation-1",
          owner: "provider_request",
          occurredAt: "2026-06-15T00:00:00.000Z",
          phase: "backoff",
          budgetId: "budget-1",
          attemptId: null,
          attemptNumber: null,
          attribution: {
            requestId: "cancel-1",
            runId: "run-1",
            operation: "retry_wait",
            observedAt: "2026-06-15T00:00:00.000Z",
            reason: "private reason",
          },
          rawError: "private provider error",
        },
      },
    });

    expect(event.payload.runtimeEvent.payload).toMatchObject({
      owner: "provider_request",
      phase: "backoff",
      attribution: {
        requestId: "cancel-1",
        operation: "retry_wait",
      },
    });
    expect(JSON.stringify(event)).not.toContain("private");
  });

  it("projects approval notifications through a fixed safe allowlist", () => {
    const event = mapRuntimeEventToHostEvent({
      sessionId: "session-1",
      runtimeEvent: {
        id: "runtime-event-approval",
        name: "approval.requested",
        taskId: "task-1",
        sequence: 5,
        timestamp: "2026-07-15T00:00:00.000Z",
        payload: {
          runId: "run-1",
          requestId: "request-1",
          actionId: "action-1",
          pendingVersion: 1,
          category: "commandExecution",
          reviewer: "user",
          phase: "reviewing",
          reviewOperationId: "review-operation-1",
          trustedProposals: [{ secret: true }],
          command: ["private", "command"],
          metadata: { private: true },
        },
      },
    });

    expect(event.payload.runtimeEvent.payload).toEqual({
      runId: "run-1",
      requestId: "request-1",
      actionId: "action-1",
      pendingVersion: 1,
      category: "commandExecution",
      reviewer: "user",
      phase: "reviewing",
      reviewOperationId: "review-operation-1",
    });
    expect(JSON.stringify(event)).not.toContain("private");
  });

  it("carries the no-safe-path RunResult rather than reconstructing a Host error", () => {
    const runResult = createBlockedRunResult(
      { runId: "run-1", taskId: "task-1" },
      "runtime_no_safe_path",
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
    expect(event.payload.runResult.code).toBe("runtime_no_safe_path");
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
