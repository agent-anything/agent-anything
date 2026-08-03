import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../events/RuntimeEvent.js";
import type { ControllerFinishedRuntimeEventPayload } from "../events/RuntimeEventPayload.js";
import { RuntimeEventStream } from "../events/RuntimeEventStream.js";
import {
  RUN_TRACE_SCHEMA_VERSION,
  type RunTrace,
  type RunTraceObserver,
} from "./RunTrace.js";
import { RunTraceAssembler } from "./RunTraceAssembler.js";

const startedAt = "2026-08-03T00:00:00.000Z";
const completedAt = "2026-08-03T00:00:01.000Z";

describe("RunTraceAssembler", () => {
  it("assembles an immutable complete trace from exact event and result facts", async () => {
    const observed: RunTrace[] = [];
    const assembler = createAssembler([{
      observe(trace) {
        observed.push(trace);
      },
    }]);
    const stream = createStream(assembler);

    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);
    stream.emit("controller.started", { iteration: 1 }, startedAt);
    stream.emit("controller.finished", {
      iteration: 1,
      status: "succeeded",
      code: null,
      decisionKind: "actions",
    }, completedAt);
    stream.emit("run.item.appended", {
      itemId: "item-1",
      itemKind: "model_output",
      itemSequence: 1,
    }, completedAt);
    stream.emit("run.completed", {
      status: "succeeded",
      code: null,
      durationMs: 1_000,
      itemCount: 1,
      evidenceCount: 0,
      artifactCount: 0,
      errorCodes: [],
    }, completedAt);

    const trace = assembler.complete({
      items: [{
        id: "item-1",
        runId: "run-1",
        sequence: 1,
        kind: "model_output",
        createdAt: completedAt,
      }],
      result: terminalResult({
        status: "succeeded",
        code: null,
        itemCount: 1,
      }),
    });
    await Promise.resolve();

    expect(trace).toMatchObject({
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
      traceId: "trace-1",
      runId: "run-1",
      taskId: "task-1",
      status: "complete",
      startedAt,
      completedAt,
      issues: [],
    });
    expect(trace.spans).toHaveLength(2);
    expect(trace.spans[0]).toMatchObject({
      owner: "runtime",
      operation: "run",
      operationId: "run-1",
      status: "succeeded",
      attributes: {
        activeAgentId: "agent-1",
        terminalCode: null,
        itemCount: 1,
      },
    });
    expect(trace.spans[1]).toMatchObject({
      parentSpanId: trace.rootSpanId,
      owner: "controller",
      operation: "turn",
      operationId: "controller-turn:1",
      status: "succeeded",
      startedAt,
      completedAt,
      attributes: {
        iteration: 1,
        decisionKind: "actions",
      },
    });
    expect(trace.spans[0]?.links).toContainEqual({
      kind: "run_item",
      id: "item-1",
    });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.spans)).toBe(true);
    expect(Object.isFrozen(trace.spans[0]?.attributes)).toBe(true);
    expect(Object.isFrozen(trace.spans[0]?.links)).toBe(true);
    expect(observed.at(-1)).toBe(trace);
  });

  it("keeps settlement-only operations unknown and reports incompleteness", () => {
    const assembler = createAssembler();
    const stream = createStream(assembler);

    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);
    stream.emit("controller.finished", {
      iteration: 1,
      status: "succeeded",
      code: null,
      decisionKind: "final_output",
    }, completedAt);
    stream.emit("run.completed", {
      status: "succeeded",
      code: null,
      durationMs: 1_000,
      itemCount: 0,
      evidenceCount: 0,
      artifactCount: 0,
      errorCodes: [],
    }, completedAt);

    const trace = assembler.complete({
      items: [],
      result: terminalResult({ status: "succeeded", code: null }),
    });

    expect(trace.status).toBe("incomplete");
    expect(trace.issues).toContainEqual({
      code: "operation_start_missing",
      sourceId: "event-2",
      operationId: "controller-turn:1",
    });
    expect(trace.spans[1]).toMatchObject({
      status: "unknown",
      startedAt: null,
      completedAt,
    });
  });

  it("uses the closed Action, approval, Sandbox, Tool, and Retry span catalog", () => {
    const assembler = createAssembler();
    const stream = createStream(assembler);

    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);
    stream.emit("tool.started", {
      actionId: "action-1",
      toolName: "codeAgent.readFile",
    }, startedAt);
    stream.emit("action.prepared", {
      actionId: "action-1",
      actionFingerprint: "fingerprint-1",
      category: "file_system",
      effectCount: 1,
      targetAssertionCount: 1,
    }, startedAt);
    stream.emit("action.assessed", {
      actionId: "action-1",
      actionFingerprint: "fingerprint-1",
      status: "approval_required",
      owner: null,
      code: null,
    }, startedAt);
    stream.emit("approval.requested", {
      requestId: "approval-1",
      actionId: "action-1",
      actionFingerprint: "fingerprint-1",
      category: "fileChange",
      pendingVersion: 1,
      reviewer: "user",
      phase: "reviewing",
      reviewOperationId: "approval-review-1",
    }, startedAt);
    stream.emit("approval.resolved", {
      requestId: "approval-1",
      actionId: "action-1",
      actionFingerprint: "fingerprint-1",
      pendingVersion: 1,
      reviewer: "user",
      resolutionKind: "decision",
      decisionKind: "accept",
      applicationKind: "applied",
      code: null,
      authorityRecordIds: [],
    }, completedAt);
    stream.emit("sandbox.attempt.started", {
      actionId: "action-1",
      attemptId: "sandbox-1",
      ordinal: 1,
      enforcement: "managed",
    }, startedAt);
    stream.emit("sandbox.attempt.resolved", {
      actionId: "action-1",
      attemptId: "sandbox-1",
      ordinal: 1,
      enforcement: "managed",
      outcome: "executed",
      code: null,
    }, completedAt);
    stream.emit("observation.created", {
      actionId: "action-1",
      observationId: "observation-1",
      status: "succeeded",
      code: null,
    }, completedAt);
    stream.emit("tool.finished", {
      actionId: "action-1",
      toolName: "codeAgent.readFile",
      status: "succeeded",
      code: null,
      toolResultStatus: "succeeded",
      durationMs: 25,
    }, completedAt);
    stream.emit("retry.attempt.started", {
      operationId: "provider-request-1",
      owner: "provider_request",
      attemptId: "retry-attempt-1",
      budgetId: "budget-1",
      attemptNumber: 1,
      budgetAttemptNumber: 1,
      maxBudgetAttempts: 2,
    }, startedAt);
    stream.emit("retry.attempt.finished", {
      operationId: "provider-request-1",
      owner: "provider_request",
      attemptId: "retry-attempt-1",
      budgetId: "budget-1",
      attemptNumber: 1,
      budgetAttemptNumber: 1,
      durationMs: 50,
      outcome: "succeeded",
      failureCategory: null,
      failureCode: null,
      next: "return_to_owner",
    }, completedAt);

    const trace = assembler.getSnapshot();
    expect(trace.status).toBe("active");
    expect(trace.issues).toEqual([]);
    expect(trace.spans.map((span) => [span.owner, span.operation, span.status]))
      .toEqual([
        ["runtime", "run", "running"],
        ["tool", "execution", "succeeded"],
        ["action", "processing", "succeeded"],
        ["approval", "review", "succeeded"],
        ["sandbox", "attempt", "succeeded"],
        ["retry", "attempt", "succeeded"],
      ]);
    const rootSpan = trace.spans.find((span) => span.owner === "runtime");
    const toolSpan = trace.spans.find((span) => span.owner === "tool");
    const actionSpan = trace.spans.find((span) => span.owner === "action");
    expect(toolSpan?.parentSpanId).toBe(rootSpan?.spanId);
    expect(actionSpan?.parentSpanId).toBe(toolSpan?.spanId);
    expect(trace.spans.find((span) => span.owner === "approval")?.parentSpanId)
      .toBe(actionSpan?.spanId);
    expect(trace.spans.find((span) => span.owner === "sandbox")?.parentSpanId)
      .toBe(actionSpan?.spanId);
    expect(trace.spans.find((span) => span.owner === "retry")?.parentSpanId)
      .toBe(rootSpan?.spanId);
    expect(trace.spans.find((span) => span.owner === "tool")?.attributes)
      .toMatchObject({
        actionId: "action-1",
        toolName: "codeAgent.readFile",
        resultStatus: "succeeded",
        reportedDurationMs: 25,
      });
    expect(trace.spans.find((span) => span.owner === "retry")?.attributes)
      .toMatchObject({
        retryOperationId: "provider-request-1",
        retryOwner: "provider_request",
        maxBudgetAttempts: 2,
        outcome: "succeeded",
      });
  });

  it("settles Tool execution without inventing Action processing when preparation never succeeds", () => {
    const assembler = createAssembler();
    const stream = createStream(assembler);

    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);
    stream.emit("tool.started", {
      actionId: "action-1",
      toolName: "codeAgent.writeFile",
    }, startedAt);
    stream.emit("tool.finished", {
      actionId: "action-1",
      toolName: "codeAgent.writeFile",
      status: "failed",
      code: "action_preparation_failed",
      toolResultStatus: "failed",
      durationMs: 10,
    }, completedAt);

    const trace = assembler.getSnapshot();
    expect(trace.issues).toEqual([]);
    expect(trace.spans.filter((span) => span.owner === "action")).toEqual([]);
    expect(trace.spans.find((span) => span.owner === "tool")).toMatchObject({
      parentSpanId: trace.rootSpanId,
      status: "failed",
      code: "action_preparation_failed",
    });
  });

  it("does not invent terminal timing or committed-item correlation", () => {
    const assembler = createAssembler();
    const stream = createStream(assembler);

    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);

    const trace = assembler.complete({
      items: [{
        id: "item-1",
        runId: "run-1",
        sequence: 1,
        kind: "run_failed",
        createdAt: completedAt,
      }],
      result: terminalResult({
        status: "failed",
        code: "provider_request_failed",
        itemCount: 1,
        errorCodes: ["provider_request_failed"],
      }),
    });

    expect(trace.status).toBe("incomplete");
    expect(trace.completedAt).toBeNull();
    expect(trace.spans[0]).toMatchObject({
      status: "failed",
      code: "provider_request_failed",
      completedAt: null,
    });
    expect(trace.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "run_item_event_missing",
        "terminal_event_missing",
      ]),
    );
  });

  it("rejects cross-Run and regressed event input without replacing known facts", () => {
    const assembler = createAssembler();
    const ownStream = createStream(assembler);
    ownStream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);

    const foreignEvent = createStream(undefined, "run-2").emit(
      "controller.started",
      { iteration: 1 },
      startedAt,
    );
    expect(() => assembler.publish(foreignEvent)).toThrow(/another Run/);

    const regressed = createStream(undefined).emit(
      "run.started",
      { status: "running", activeAgentId: "agent-1" },
      startedAt,
    );
    expect(() => assembler.publish(regressed)).toThrow(/regresses/);
    expect(assembler.getSnapshot()).toMatchObject({
      status: "incomplete",
      startedAt,
    });
    expect(assembler.getSnapshot().issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "run_identity_mismatch",
        "event_sequence_regression",
      ]),
    );
  });

  it("accepts a later ordered event only with an explicit sequence-gap issue", () => {
    const assembler = createAssembler();
    createStream(assembler).emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);
    const source = createStream(undefined);
    source.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, startedAt);
    source.emit("plan.created", {
      plan: {
        id: "plan-1",
        version: 1,
        status: "active",
        steps: [],
      },
    }, startedAt);
    const later = source.emit(
      "controller.started",
      { iteration: 1 },
      startedAt,
    );

    assembler.publish(later);

    expect(assembler.getSnapshot().issues).toContainEqual({
      code: "event_sequence_gap",
      sourceId: "event-3",
      operationId: "controller-turn:1",
    });
    expect(assembler.getSnapshot().spans[1]).toMatchObject({
      operationId: "controller-turn:1",
      status: "running",
    });
  });

  it("redacts undeclared Product data and isolates sync and async observers", async () => {
    const observed: RunTrace[] = [];
    const observers: RunTraceObserver[] = [
      { observe() { throw new Error("sync observer failed"); } },
      { observe() { return Promise.reject(new Error("async observer failed")); } },
      { observe(trace) { observed.push(trace); } },
    ];
    const assembler = createAssembler(observers);
    const stream = createStream(assembler);

    expect(() => stream.emit("controller.started", { iteration: 1 }, startedAt))
      .not.toThrow();
    expect(observed).toHaveLength(0);
    expect(() => stream.emit("controller.finished", {
      iteration: 1,
      status: "succeeded",
      code: null,
      decisionKind: "actions",
      rawPrompt: "secret",
      promptArchitectureVersion: "product-only",
    } as ControllerFinishedRuntimeEventPayload, completedAt)).not.toThrow();
    await Promise.resolve();

    const span = assembler.getSnapshot().spans[1];
    expect(span?.attributes).toEqual({
      iteration: 1,
      decisionKind: "actions",
      code: null,
    });
    expect(span?.attributes).not.toHaveProperty("rawPrompt");
    expect(span?.attributes).not.toHaveProperty("promptArchitectureVersion");
    expect(observed).toHaveLength(2);
    expect(() => Object.assign(
      span?.attributes as object,
      { rawPrompt: "mutated" },
    )).toThrow();
  });
});

function createAssembler(
  observers: readonly RunTraceObserver[] = [],
): RunTraceAssembler {
  return new RunTraceAssembler({
    traceId: "trace-1",
    runId: "run-1",
    taskId: "task-1",
    createSpanId: ({ sequence }) => `span-${sequence}`,
    observers,
  });
}

function createStream(
  publisher: RunTraceAssembler | undefined,
  runId = "run-1",
): RuntimeEventStream {
  return new RuntimeEventStream({
    runId,
    taskId: "task-1",
    now: () => startedAt,
    createEventId: ({ sequence }) => `event-${sequence}`,
    publishers: publisher === undefined ? [] : [publisher],
  });
}

function terminalResult(input: {
  readonly status: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly code: string | null;
  readonly itemCount?: number;
  readonly errorCodes?: readonly string[];
}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    status: input.status,
    code: input.code,
    itemCount: input.itemCount ?? 0,
    evidenceCount: 0,
    artifactCount: 0,
    errorCodes: input.errorCodes ?? [],
  } as const;
}
