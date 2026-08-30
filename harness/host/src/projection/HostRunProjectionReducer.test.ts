import { describe, expect, it, vi } from "vitest";
import type { RunOperationSnapshot } from "@agent-anything/agent-runtime/runner";
import { createSucceededRunResult } from "@agent-anything/agent-runtime/run";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  snapshotRuntimeEventPayload,
  type RuntimeEvent,
  type RuntimeEventName,
  type RuntimeEventPayloadMap,
} from "@agent-anything/observability/events";
import type { InteractionRequestRef } from "@agent-anything/interaction/protocol";
import {
  createHostRunProjection,
  createHostTerminalRunProjection,
  type HostRunProjection,
  type HostRunProjectionUpdate,
} from "./HostRunProjection.js";
import {
  createHostRunProjectionStore,
  reduceHostRunProjection,
} from "./HostRunProjectionReducer.js";

describe("HostRunProjectionReducer", () => {
  it("moves from starting to running only on confirmed run.started and terminalizes from RunResult", () => {
    let projection = initialProjection();
    projection = apply(projection, runtimeUpdate(1, "run.started", {
      status: "running",
      ...runStartedIdentity("agent-1"),
    }));
    expect(projection).toMatchObject({ sequence: 1, status: "running" });

    const terminal = createHostTerminalRunProjection({
      runResult: succeededResult(),
      completedAt: LATER,
    });
    projection = apply(projection, {
      kind: "terminal_result",
      runId: "run-1",
      sequence: 2,
      occurredAt: LATER,
      terminal,
    });

    expect(projection).toMatchObject({
      status: "completed",
      terminal: {
        runId: "run-1",
        code: null,
        itemCount: 0,
      },
    });
    expect(JSON.stringify(projection)).not.toContain("private final output");
  });

  it("projects Plan and generic pending Interaction only from RunHandle snapshots", () => {
    let projection = apply(initialProjection(), runtimeUpdate(1, "run.started", {
      status: "running",
      ...runStartedIdentity("agent-1"),
    }));
    projection = apply(projection, runOperationUpdate(2, {
      sequence: 1,
      status: "waiting",
      plan: {
        id: "plan-1",
        version: 1,
        status: "active",
        steps: [{ step: "Inspect files", status: "in_progress" }],
      },
      pendingInteractions: [{
        envelope: {
          request: REQUEST,
          presentation: { title: "Approve Action" },
          disclosureClass: "public",
          expiresAt: null,
        },
        blockingScope: "run",
      }],
    }));

    expect(projection).toMatchObject({
      status: "waiting",
      runOperationSequence: 1,
      plan: { id: "plan-1", version: 1 },
      pendingInteractions: [{
        request: REQUEST,
        phase: "pending",
        blockingScope: "run",
      }],
    });
    projection = apply(projection, {
      kind: "interaction_submission_accepted",
      runId: "run-1",
      sequence: 3,
      occurredAt: NOW,
      receipt: {
        receiptId: "interaction-receipt-1",
        request: REQUEST,
        submissionId: "submission-1",
        status: "accepted_for_resolution",
        recordedAt: NOW,
      },
    });
    expect(projection.pendingInteractions[0]?.phase).toBe("submitted_for_resolution");

    projection = apply(projection, runOperationUpdate(4, {
      sequence: 2,
      status: "running",
      plan: projection.plan,
      pendingInteractions: [],
    }));
    expect(projection).toMatchObject({ status: "running", pendingInteractions: [] });
  });

  it("copies bounded Stop Review only from RunHandle snapshots and rejects regression", () => {
    const source = stopReviewSnapshot(2);
    let projection = apply(initialProjection(), runOperationUpdate(1, {
      sequence: 1,
      stopReview: source,
    }));

    expect(projection.stopReview).toEqual({
      reviewSequence: 2,
      requiredFeedbackRounds: 1,
      advisoryFeedbackRounds: 1,
      latestReview: { runId: "run-1", sequence: 2 },
      limitations: [{
        owner: "plan",
        code: "plan_reconciliation_feedback_exhausted",
        message: "Plan reconciliation remained incomplete.",
      }],
    });
    expect(Object.isFrozen(projection.stopReview)).toBe(true);
    expect(Object.isFrozen(projection.stopReview.limitations)).toBe(true);
    expect(Object.isFrozen(projection.stopReview.limitations[0])).toBe(true);

    projection = apply(projection, runtimeUpdate(2, "run.stop.reviewed", {
      reviewSequence: 99,
      decision: "allow_stop",
      checkCount: 2,
      limitationCount: 0,
      requiredFeedbackRounds: 1,
      advisoryFeedbackRounds: 1,
    }));
    expect(projection.stopReview.reviewSequence).toBe(2);

    expect(reduceHostRunProjection(projection, runOperationUpdate(3, {
      sequence: 2,
      stopReview: initialStopReview(),
    }))).toMatchObject({
      status: "rejected",
      code: "run_stop_review_sequence_regression",
    });
  });

  it("projects only the bounded Host Verification view from a RunHandle snapshot", () => {
    const verification = Object.freeze({
      snapshot: Object.freeze({ runId: "run-1", revision: 7 }),
      counts: Object.freeze([
        Object.freeze({ state: "satisfied" as const, count: 1 }),
      ]),
      activeChecks: 0,
      gateStatus: "completion_eligible" as const,
      safeReasons: Object.freeze(["verification_completion_eligible"]),
      updatedAt: NOW,
    });
    const projection = apply(initialProjection(), runOperationUpdate(1, {
      sequence: 1,
      runRevision: 3,
      verification,
    }));

    expect(projection.verification).toEqual(verification);
    expect(JSON.stringify(projection.verification)).not.toContain("evidence");
    expect(JSON.stringify(projection.verification)).not.toContain("command");
  });

  it("projects canonical Action attempt and settlement without executor payload", () => {
    let projection = apply(initialProjection(), runtimeUpdate(1, "run.started", {
      status: "running",
      ...runStartedIdentity("agent-1"),
    }));
    projection = apply(projection, {
      kind: "action_execution",
      runId: "run-1",
      sequence: 2,
      occurredAt: NOW,
      notification: {
        kind: "attempt_started",
        runId: "run-1",
        actionId: "action-1",
        attemptId: "attempt-1",
        ordinal: 1,
        enforcement: "disabled",
        occurredAt: NOW,
      },
    });
    projection = apply(projection, {
      kind: "action_execution",
      runId: "run-1",
      sequence: 3,
      occurredAt: LATER,
      notification: {
        kind: "settled",
        runId: "run-1",
        actionId: "action-1",
        settlementId: "settlement-1",
        status: "succeeded",
        attemptCount: 1,
        enforcement: "disabled",
        causeOwner: null,
        causeRef: null,
        occurredAt: LATER,
      },
    });

    expect(projection.enforcement).toEqual({
      selected: "disabled",
      status: "unisolated",
      attemptCount: 1,
      latestAttempt: {
        attemptId: "attempt-1",
        actionId: "action-1",
        ordinal: 1,
        enforcement: "disabled",
        outcome: "succeeded",
        code: null,
      },
    });
    expect(JSON.stringify(projection.enforcement)).not.toContain("payload");
  });

  it("rejects stale, cross-Run, regressed, and post-terminal updates by identity", () => {
    const started = apply(initialProjection(), runtimeUpdate(1, "run.started", {
      status: "running",
      ...runStartedIdentity("agent-1"),
    }));
    expect(reduceHostRunProjection(
      started,
      runtimeUpdate(1, "controller.started", { turnId: "turn-1", iteration: 1 }),
    )).toMatchObject({ status: "rejected", code: "stale_sequence" });
    expect(reduceHostRunProjection(
      started,
      runtimeUpdate(2, "controller.started", { turnId: "turn-1", iteration: 1 }, "run-2"),
    )).toMatchObject({ status: "rejected", code: "run_tree_root_mismatch" });
    expect(reduceHostRunProjection(
      started,
      runOperationUpdate(2, { sequence: 0, status: "running" }),
    )).toMatchObject({ status: "applied" });
    const advanced = apply(started, runOperationUpdate(2, { sequence: 2, status: "running" }));
    expect(reduceHostRunProjection(
      advanced,
      runOperationUpdate(3, { sequence: 1, status: "running" }),
    )).toMatchObject({ status: "rejected", code: "run_operation_sequence_regression" });

    const terminal = createHostTerminalRunProjection({ runResult: succeededResult() });
    const completed = apply(advanced, {
      kind: "terminal_result",
      runId: "run-1",
      sequence: 3,
      occurredAt: LATER,
      terminal,
    });
    const postTerminal = reduceHostRunProjection(
      completed,
      runtimeUpdate(4, "controller.started", { turnId: "turn-2", iteration: 2 }),
    );
    expect(postTerminal).toMatchObject({
      status: "rejected",
      code: "invalid_transition",
      projection: { sequence: 3, status: "completed" },
    });
    expect(postTerminal.projection).toBe(completed);
  });

  it("isolates subscriber and failure-reporter exceptions", () => {
    const listenerFailure = new Error("listener failed");
    const onListenerFailure = vi.fn(() => {
      throw new Error("failure reporter failed");
    });
    const delivered = vi.fn();
    const store = createHostRunProjectionStore({
      initial: initialProjection(),
      onListenerFailure,
    });
    store.subscribe(() => {
      throw listenerFailure;
    });
    store.subscribe(delivered);

    const result = store.apply(runtimeUpdate(1, "run.started", {
      status: "running",
      ...runStartedIdentity("agent-1"),
    }));

    expect(result).toMatchObject({ status: "applied", projection: { status: "running" } });
    expect(onListenerFailure).toHaveBeenCalledWith({
      runId: "run-1",
      sequence: 1,
      error: listenerFailure,
    });
    expect(delivered).toHaveBeenCalledWith(store.getProjection());
  });

  it("accepts same-root descendant activity without changing root lifecycle and rejects wrong or stale trees", () => {
    const childLineage: RuntimeEvent["lineage"] = {
      kind: "descendant",
      root: { id: "run-1" },
      parent: { id: "run-1" },
      parentRunAction: { run: { id: "run-1" }, id: "action-1", sequence: 1 },
      relation: { id: "relation-1" },
      depth: 1,
    };
    let projection = apply(initialProjection(), runtimeUpdate(
      1,
      "run.started",
      { status: "running", ...runStartedIdentity("agent-child", "run-child") },
      "run-child",
      childLineage,
    ));
    expect(projection.status).toBe("starting");
    expect(reduceHostRunProjection(
      projection,
      runtimeUpdate(2, "run.started", {
        status: "running",
        ...runStartedIdentity("foreign-agent", "run-foreign"),
      }, "run-foreign"),
    )).toMatchObject({ status: "rejected", code: "run_tree_root_mismatch" });

    projection = apply(projection, runOperationUpdate(2, {
      sequence: 1,
      runTree: treeWithChild(2),
      activeDelegations: [{
        request: { id: "request-1", revision: "request-1-v1" },
        relation: { id: "relation-1" },
        child: { id: "run-child" },
        childRunRevision: 4,
        childStatus: "running",
        steerable: true,
      }],
    }));
    expect(projection.runTree).toMatchObject({
      revision: 2,
      totalDescendantRuns: 1,
      activeDescendantRuns: 1,
      resources: {
        controllerTurns: { capacity: 100, consumed: 0 },
      },
      approvals: { totalRequests: 0, activeReviews: 0 },
      settlement: { complete: false },
      nodes: [
        { runId: "run-1", depth: 0, resultTransfer: "not_required" },
        { runId: "run-child", depth: 1, status: "running", resultTransfer: "pending" },
      ],
    });
    expect(JSON.stringify(projection.runTree)).not.toContain("delegated prompt");
    expect(JSON.stringify(projection.runTree)).not.toContain("authorityRevision");
    expect(JSON.stringify(projection.runTree)).not.toContain("operationFingerprint");
    expect(projection.activeDelegations).toEqual([{
      request: { id: "request-1", revision: "request-1-v1" },
      relation: { id: "relation-1" },
      child: { id: "run-child" },
      childRunRevision: 4,
      childStatus: "running",
      steerable: true,
    }]);
    expect(Object.isFrozen(projection.activeDelegations[0]?.request)).toBe(true);

    expect(reduceHostRunProjection(projection, runOperationUpdate(3, {
      sequence: 2,
      runTree: treeWithChild(1),
    }))).toMatchObject({
      status: "rejected",
      code: "run_tree_revision_regression",
    });
  });
});

function initialProjection(): HostRunProjection {
  return createHostRunProjection({
    sessionId: "session-1",
    taskId: "task-1",
    runId: "run-1",
    startedAt: NOW,
    enforcement: "disabled",
    runTree: rootTree(),
  });
}

function apply(
  current: HostRunProjection,
  update: HostRunProjectionUpdate,
): HostRunProjection {
  const result = reduceHostRunProjection(current, update);
  expect(result.status).toBe("applied");
  return result.projection;
}

function runtimeUpdate<TName extends RuntimeEventName>(
  sequence: number,
  name: TName,
  payload: RuntimeEventPayloadMap[TName],
  eventRunId = "run-1",
  lineage: RuntimeEvent["lineage"] = {
    kind: "root",
    root: { id: eventRunId },
    depth: 0,
  },
): HostRunProjectionUpdate {
  return {
    kind: "runtime_event",
    runId: "run-1",
    sequence,
    occurredAt: NOW,
    event: {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: `event-${sequence}`,
      runId: eventRunId,
      taskId: "task-1",
      lineage,
      sequence,
      name,
      occurredAt: NOW,
      payload: snapshotRuntimeEventPayload(name, payload),
    } as RuntimeEvent,
  };
}

function runOperationUpdate(
  sequence: number,
  overrides: Partial<RunOperationSnapshot>,
): HostRunProjectionUpdate {
  return {
    kind: "run_operation",
    runId: "run-1",
    sequence,
    occurredAt: NOW,
    snapshot: {
      runId: "run-1",
      sequence: 1,
      runRevision: 1,
      status: "running",
      lastRunItemSequence: 0,
      instructionBinding: null,
      plan: null,
      stopReview: initialStopReview(),
      retry: null,
      verification: null,
      pendingInteractions: [],
      activeDelegations: [],
      runTree: rootTree(),
      result: null,
      ...overrides,
    },
  };
}

function initialStopReview(): RunOperationSnapshot["stopReview"] {
  return Object.freeze({
    reviewSequence: 0,
    requiredFeedbackRounds: 0,
    advisoryFeedbackRounds: 0,
    latestReview: null,
    limitations: Object.freeze([]),
  });
}

function stopReviewSnapshot(
  reviewSequence: number,
): RunOperationSnapshot["stopReview"] {
  return Object.freeze({
    reviewSequence,
    requiredFeedbackRounds: 1,
    advisoryFeedbackRounds: 1,
    latestReview: Object.freeze({ runId: "run-1", sequence: reviewSequence }),
    limitations: Object.freeze([Object.freeze({
      owner: "plan" as const,
      code: "plan_reconciliation_feedback_exhausted",
      message: "Plan reconciliation remained incomplete.",
    })]),
  });
}

function rootTree(revision = 0): RunOperationSnapshot["runTree"] {
  return Object.freeze({
    rootRunId: "run-1",
    revision,
    deadlineAt: "2026-08-13T00:01:00.000Z",
    limits: Object.freeze({
      maxDescendantDepth: 2,
      maxTotalDescendantRuns: 4,
      maxActiveDescendantRuns: 2,
    }),
    totalDescendantRuns: 0,
    activeDescendantRuns: 0,
    resources: treeResources(),
    approvals: approvalSnapshot(),
    cancellation: cancellationSnapshot(),
    settlement: settlementSnapshot(),
    nodes: Object.freeze([Object.freeze({
      runId: "run-1",
      parentRunId: null,
      relationId: null,
      parentRunActionId: null,
      depth: 0,
      status: "initializing" as const,
      resultCode: null,
      startedAt: NOW,
      completedAt: null,
      resources: nodeResources("run-1", null),
      authorityRevision: "run-1:authority:active:0",
      cancellation: null,
      resultTransfer: "not_required" as const,
    })]),
  });
}

function treeWithChild(revision: number): RunOperationSnapshot["runTree"] {
  return Object.freeze({
    ...rootTree(revision),
    totalDescendantRuns: 1,
    activeDescendantRuns: 1,
    nodes: Object.freeze([
      rootTree(revision).nodes[0]!,
      Object.freeze({
        runId: "run-child",
        parentRunId: "run-1",
        relationId: "relation-1",
        parentRunActionId: "action-1",
        depth: 1,
        status: "running" as const,
        resultCode: null,
        startedAt: NOW,
        completedAt: null,
        resources: nodeResources("run-child", "run-1"),
        authorityRevision: "run-child:authority:active:0",
        cancellation: null,
        resultTransfer: "pending" as const,
      }),
    ]),
  });
}

function treeResources() {
  const resource = () => Object.freeze({
    capacity: 100,
    consumed: 0,
    reserved: 0,
    remaining: 100,
    released: 0,
    measurementStatus: "measured" as const,
    enforcement: "hard" as const,
  });
  return Object.freeze({
    controllerTurns: resource(), actions: resource(), modelInputTokens: resource(),
    modelOutputTokens: resource(), costUnits: resource(), contextBytes: resource(),
    resultBytes: resource(),
  });
}

function nodeResources(runId: string, parentRunId: string | null) {
  const amounts = Object.freeze({
    controllerTurns: 100, actions: 100, modelInputTokens: 100,
    modelOutputTokens: 100, costUnits: 100, contextBytes: 100, resultBytes: 100,
  });
  const usage = Object.freeze(Object.fromEntries(
    Object.keys(amounts).map((key) => [key, Object.freeze({ status: "measured" as const, value: 0 })]),
  )) as RunOperationSnapshot["runTree"]["nodes"][number]["resources"]["usage"];
  return Object.freeze({
    runId, parentRunId, allocation: amounts, remaining: amounts, usage,
    settled: false, revision: 0,
  });
}

function approvalSnapshot() {
  return Object.freeze({
    limits: Object.freeze({
      maxTotalRequests: 4, maxRequestsPerOperationFingerprint: 2,
      maxConsecutiveDeclines: 2, maxConsecutiveReviewerFailures: 2,
      maxActiveReviews: 2,
    }),
    revision: 0, totalRequests: 0, activeReviews: 0, settledRequests: 0,
    uniqueOperationFingerprints: 0, maxEquivalentOperationRequests: 0,
    consecutiveDeclines: 0, consecutiveReviewerFailures: 0, exhaustedCode: null,
  });
}

function cancellationSnapshot() {
  return Object.freeze({
    totalRequests: 0, treeRequested: false, subtreeRequests: 0, latest: null,
  });
}

function settlementSnapshot() {
  return Object.freeze({
    complete: false, unsettledDescendantRuns: 0, pendingResultTransfers: 0,
    failedResultTransfers: 0, unknownResultTransfers: 0,
  });
}

function succeededResult() {
  return createSucceededRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startingInstructionBinding: instructionBindingRef("run-1"),
    finalInstructionBinding: instructionBindingRef("run-1"),
    startedAt: NOW,
    completedAt: LATER,
    metadata: { durationMs: 1_000, privatePrompt: "must not survive" },
  }, { summary: "private final output" });
}

const REQUEST: InteractionRequestRef = Object.freeze({
  id: "interaction-1",
  protocol: Object.freeze({ owner: "permission", kind: "approval", revision: "1" }),
  requestVersion: 1,
  subject: Object.freeze({
    owner: "canonical-action",
    kind: "action-subject",
    id: "action-1",
    revision: "1",
  }),
});
const NOW = "2026-08-13T00:00:00.000Z";
const LATER = "2026-08-13T00:00:01.000Z";

function runStartedIdentity(agentId: string, runId = "run-1") {
  return {
    activeAgentId: agentId,
    activeAgentRevision: "1",
    instructionBindingId: `${runId}:agent-instruction-binding:0`,
    instructionBindingRevision: `sha256:${"0".repeat(64)}`,
  };
}

function instructionBindingRef(runId: string) {
  return Object.freeze({
    id: `${runId}:agent-instruction-binding:0`,
    revision: `sha256:${"0".repeat(64)}`,
  });
}
