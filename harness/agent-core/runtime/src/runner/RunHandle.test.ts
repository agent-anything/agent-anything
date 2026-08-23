import { describe, expect, it, vi } from "vitest";
import {
  createRunCancellationController,
  createRunFailureCause,
  createFailedRunResult,
  createSucceededRunResult,
} from "../run/index.js";
import { ActiveRunHandle, type RunExecutionUpdate } from "./RunHandle.js";
import type { RunTreeExecutionSnapshot } from "./RunTreeExecution.js";

describe("ActiveRunHandle", () => {
  it("applies settlement once even when the terminal result was already published", async () => {
    const result = succeededResult();
    const onSettled = vi.fn();
    const handle = new ActiveRunHandle(
      "run-1",
      cancellation(),
      result,
      runTree(0),
      onSettled,
    );
    handle.start(async () => result);
    handle.publish(terminalUpdate(result));

    await expect(handle.wait()).resolves.toBe(result);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(result);
  });

  it("publishes a newer tree revision and isolates listener failure", () => {
    const result = succeededResult();
    const handle = new ActiveRunHandle(
      "run-1",
      cancellation(),
      result,
      runTree(0),
      () => undefined,
    );
    const delivered = vi.fn();
    handle.subscribe(() => {
      throw new Error("listener failed");
    });
    handle.subscribe(delivered);

    handle.publishRunTree(runTree(1));

    expect(handle.getSnapshot()).toMatchObject({
      sequence: 1,
      runTree: { rootRunId: "run-1", revision: 1 },
    });
    expect(delivered).toHaveBeenLastCalledWith(handle.getSnapshot());
    expect(() => handle.publishRunTree(runTree(0))).toThrow(
      "stale Run Tree revision",
    );
  });

  it("settles an execution rejection through the emergency result exactly once", async () => {
    const emergencyResult = failedResult();
    const onSettled = vi.fn();
    const handle = new ActiveRunHandle(
      "run-1",
      cancellation(),
      emergencyResult,
      runTree(0),
      onSettled,
    );

    handle.start(async () => {
      throw new Error("execution rejected");
    });

    await expect(handle.wait()).resolves.toBe(emergencyResult);
    expect(handle.getResult()).toBe(emergencyResult);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(emergencyResult);
  });
});

function terminalUpdate(
  result: ReturnType<typeof succeededResult>,
): RunExecutionUpdate<{ summary: string }> {
  return {
    runRevision: 1,
    status: "succeeded",
    lastRunItemSequence: 0,
    plan: null,
    retry: null,
    validation: null,
    pendingInteractions: [],
    result,
  };
}

function cancellation() {
  return createRunCancellationController({
    runId: "run-1",
    now: () => NOW,
    createRequestId: () => "cancellation-1",
  });
}

function succeededResult() {
  return createSucceededRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startedAt: NOW,
    completedAt: LATER,
  }, { summary: "done" });
}

function failedResult() {
  return createFailedRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startedAt: NOW,
    completedAt: LATER,
  }, "runtime_execution_failed", createRunFailureCause("runtime", {
    code: "runtime_execution_failed",
    message: "Run execution rejected before normal failure materialization.",
    retryable: false,
    metadata: {},
  }));
}

function runTree(revision: number): RunTreeExecutionSnapshot {
  return Object.freeze({
    rootRunId: "run-1",
    revision,
    deadlineAt: "2026-08-23T00:01:00.000Z",
    limits: Object.freeze({
      maxDescendantDepth: 2,
      maxTotalDescendantRuns: 4,
      maxActiveDescendantRuns: 2,
    }),
    totalDescendantRuns: 0,
    activeDescendantRuns: 0,
    nodes: Object.freeze([Object.freeze({
      runId: "run-1",
      parentRunId: null,
      relationId: null,
      parentRunActionId: null,
      depth: 0,
      status: "running" as const,
      resultCode: null,
      startedAt: NOW,
      completedAt: null,
    })]),
  });
}

const NOW = "2026-08-23T00:00:00.000Z";
const LATER = "2026-08-23T00:00:01.000Z";
