import { describe, expect, it, vi } from "vitest";
import {
  createRunCancellationController,
  createRunFailureCause,
  createFailedRunResult,
  createSucceededRunResult,
} from "../run/index.js";
import {
  createInitialRunStopReviewState,
  projectRunStopReview,
} from "../stop/index.js";
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

  it("publishes one snapshot when execution and tree projections advance together", () => {
    const result = succeededResult();
    const handle = new ActiveRunHandle(
      "run-1",
      cancellation(),
      result,
      runTree(0),
      () => undefined,
    );
    const delivered = vi.fn();
    handle.subscribe(delivered);

    handle.publish({
      ...terminalUpdate(result),
      status: "running",
      result: null,
    }, runTree(1));

    expect(handle.getSnapshot()).toMatchObject({
      sequence: 1,
      runRevision: 1,
      status: "running",
      runTree: { revision: 1 },
    });
    expect(delivered).toHaveBeenCalledTimes(2);
  });

  it("copies and freezes the authoritative Stop Review projection", () => {
    const result = succeededResult();
    const handle = new ActiveRunHandle(
      "run-1",
      cancellation(),
      result,
      runTree(0),
      () => undefined,
    );
    const limitations = [{
      owner: "plan" as const,
      code: "plan_remains_active",
      message: "The Run stopped with an active Plan.",
    }];

    handle.publish({
      runRevision: 2,
      status: "running",
      lastRunItemSequence: 4,
      plan: null,
      stopReview: {
        reviewSequence: 2,
        requiredFeedbackRounds: 1,
        advisoryFeedbackRounds: 1,
        latestReview: { runId: "run-1", sequence: 2 },
        limitations,
      },
      retry: null,
      verification: null,
      pendingInteractions: [],
      activeDelegations: [],
      continuationTargets: [],
      result: null,
    });

    limitations[0]!.message = "changed-after-publish";
    const stopReview = handle.getSnapshot().stopReview;
    expect(stopReview.limitations[0]?.message).toBe("The Run stopped with an active Plan.");
    expect(Object.isFrozen(stopReview)).toBe(true);
    expect(Object.isFrozen(stopReview.limitations)).toBe(true);
    expect(Object.isFrozen(stopReview.limitations[0])).toBe(true);
    expect(Object.isFrozen(stopReview.latestReview)).toBe(true);
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

  it("delegates descendant steering only through its bound Runner route", () => {
    const result = succeededResult();
    const handle = new ActiveRunHandle(
      "run-1",
      cancellation(),
      result,
      runTree(0),
      () => undefined,
    );
    const route = {
      request: { id: "request-1", revision: "request-1-v1" },
      relation: { id: "relation-1" },
      child: { id: "run-child" },
      steering: {
        commandId: "steering-1",
        expectedRunRevision: 2,
        instruction: "Inspect the public contract.",
        attribution: { origin: "user" as const, actorId: "user-1" },
        submittedAt: NOW,
      },
    };
    expect(handle.steerDescendant(route)).toMatchObject({
      status: "rejected",
      code: "delegation_route_invalid",
    });
    const routeImpl = vi.fn(() => Object.freeze({
      status: "rejected" as const,
      code: "delegation_child_settled" as const,
      relation: route.relation,
      child: route.child,
    }));
    handle.bindDescendantSteering(routeImpl);

    expect(handle.steerDescendant(route)).toMatchObject({
      status: "rejected",
      code: "delegation_child_settled",
    });
    expect(routeImpl).toHaveBeenCalledWith(route);
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
    stopReview: projectRunStopReview(createInitialRunStopReviewState()),
    retry: null,
    verification: null,
      pendingInteractions: [],
      activeDelegations: [],
      continuationTargets: [],
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
  const instructionBinding = testInstructionBinding();
  return createSucceededRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startingInstructionBinding: instructionBinding,
    finalInstructionBinding: instructionBinding,
    startedAt: NOW,
    completedAt: LATER,
  }, { summary: "done" });
}

function failedResult() {
  const instructionBinding = testInstructionBinding();
  return createFailedRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startingInstructionBinding: instructionBinding,
    finalInstructionBinding: instructionBinding,
    startedAt: NOW,
    completedAt: LATER,
  }, "runtime_execution_failed", createRunFailureCause("runtime", {
    code: "runtime_execution_failed",
    message: "Run execution rejected before normal failure materialization.",
    retryable: false,
    metadata: {},
  }));
}

function testInstructionBinding() {
  return Object.freeze({
    id: "run-1:agent-instruction-binding:0",
    revision: `sha256:${"0".repeat(64)}`,
  });
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
