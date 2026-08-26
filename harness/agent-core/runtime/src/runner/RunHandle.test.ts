import { describe, expect, it, vi } from "vitest";
import {
  createRunCancellationController,
  createRunFailureCause,
  createFailedRunResult,
  createSucceededRunResult,
} from "../run/index.js";
import {
  createInitialRunProgressState,
  projectRunProgress,
} from "../progress/index.js";
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

  it("copies and freezes the authoritative Run Progress projection", () => {
    const result = succeededResult();
    const handle = new ActiveRunHandle(
      "run-1",
      cancellation(),
      result,
      runTree(0),
      () => undefined,
    );
    const sourceFactRefs = [{
      kind: "operation_result" as const,
      owner: "workspace",
      subjectId: "file-1",
      revision: "2",
    }];

    handle.publish({
      runRevision: 2,
      status: "running",
      lastRunItemSequence: 4,
      plan: null,
      progress: {
        checkpointSequence: 2,
        disposition: "repeated",
        reasonCode: "equivalent_fact_repeated",
        consecutiveNonAdvancingCheckpoints: 2,
        correctionRounds: 1,
        activeCorrectionRound: 1,
        latestAssessment: { runId: "run-1", checkpointSequence: 2 },
        latestAdvancement: { runId: "run-1", checkpointSequence: 1 },
        factRefs: sourceFactRefs,
      },
      retry: null,
      validation: null,
      pendingInteractions: [],
      activeDelegations: [],
      result: null,
    });

    sourceFactRefs[0]!.revision = "changed-after-publish";
    const progress = handle.getSnapshot().progress;
    expect(progress.factRefs[0]?.revision).toBe("2");
    expect(Object.isFrozen(progress)).toBe(true);
    expect(Object.isFrozen(progress.factRefs)).toBe(true);
    expect(Object.isFrozen(progress.factRefs[0])).toBe(true);
    expect(Object.isFrozen(progress.latestAssessment)).toBe(true);
    expect(Object.isFrozen(progress.latestAdvancement)).toBe(true);
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
    progress: projectRunProgress(createInitialRunProgressState(), null),
    retry: null,
    validation: null,
      pendingInteractions: [],
      activeDelegations: [],
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
