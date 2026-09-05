import { describe, expect, it, vi } from "vitest";
import {
  createRunCancellationController,
  createRunFailureCause,
  createRunResult,
  type RunSettlementCauseRecord,
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

  it("delegates descendant steering and resume only through their bound Runner routes", () => {
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

    const resumeRoute = {
      request: route.request,
      relation: route.relation,
      child: route.child,
      resume: {
        id: "resume-1",
        expectedRunRevision: 3,
        suspension: {
          run: route.child,
          id: "suspension-1",
          revision: "suspension-1-v1",
        },
        origin: "host" as const,
        reason: "Continue the suspended Child.",
      },
    };
    expect(handle.resumeDescendant(resumeRoute)).toMatchObject({
      status: "rejected",
      code: "delegation_route_invalid",
    });
    const resumeImpl = vi.fn(() => Object.freeze({
      status: "rejected" as const,
      code: "delegation_child_settled" as const,
      relation: resumeRoute.relation,
      child: resumeRoute.child,
    }));
    handle.bindDescendantResume(resumeImpl);

    expect(handle.resumeDescendant(resumeRoute)).toMatchObject({
      status: "rejected",
      code: "delegation_child_settled",
    });
    expect(resumeImpl).toHaveBeenCalledWith(resumeRoute);
  });
});

function terminalUpdate(
  result: ReturnType<typeof succeededResult>,
): RunExecutionUpdate<{ summary: string }> {
  return {
    runRevision: 1,
    status: "succeeded",
    lastRunItemSequence: 0,
    instructionBinding: null,
    plan: null,
    suspension: null,
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
  const cause = completionCause();
  return createRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startingInstructionBinding: instructionBinding,
    finalInstructionBinding: instructionBinding,
    startedAt: NOW,
    settlement: {
      status: "succeeded",
      completedAt: LATER,
      cause: cause.ref,
      output: { summary: "done" },
    },
    cause,
    settlementCauses: [cause],
  });
}

function failedResult() {
  const instructionBinding = testInstructionBinding();
  const failure = createRunFailureCause("runtime", {
    code: "runtime_execution_failed",
    message: "Run execution rejected before normal failure materialization.",
    retryable: false,
    metadata: {},
  });
  const cause: Extract<RunSettlementCauseRecord, { kind: "failure" }> = {
    ref: causeRef(),
    kind: "failure",
    failure,
    source: causeSource("runtime_failure"),
    underlying: [],
    omittedUnderlyingCount: 0,
    recordedAt: LATER,
  };
  return createRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startingInstructionBinding: instructionBinding,
    finalInstructionBinding: instructionBinding,
    startedAt: NOW,
    settlement: {
      status: "failed",
      completedAt: LATER,
      cause: cause.ref,
    },
    cause,
    settlementCauses: [cause],
  });
}

function completionCause(): Extract<RunSettlementCauseRecord, { kind: "completion" }> {
  return {
    ref: causeRef(),
    kind: "completion",
    code: "completion_accepted",
    source: causeSource("run_completion_acceptance"),
    underlying: [],
    omittedUnderlyingCount: 0,
    recordedAt: LATER,
  };
}

function causeRef() {
  return { run: { id: "run-1" }, id: "run-1:cause:1", revision: "1" };
}

function causeSource(kind: string) {
  return {
    owner: "agent-runtime",
    kind,
    id: `run-1:${kind}:1`,
    revision: "1",
    run: { id: "run-1" },
  };
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
      relationKind: null,
      parentRunActionId: null,
      dispatch: null,
      depth: 0,
      status: "running" as const,
      terminal: null,
      startedAt: NOW,
      completedAt: null,
      resources: Object.freeze({
        status: "active" as const,
        revision: 0,
        reserved: Object.freeze({}),
        consumed: Object.freeze({}),
        released: Object.freeze({}),
      }),
      authorityRevision: "root-authority-v1",
      cancellation: null,
      resultTransfer: "not_required" as const,
    })]),
  });
}

const NOW = "2026-08-23T00:00:00.000Z";
const LATER = "2026-08-23T00:00:01.000Z";
