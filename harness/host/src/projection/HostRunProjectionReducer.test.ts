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
      activeAgentId: "agent-1",
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
      activeAgentId: "agent-1",
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

  it("projects only the bounded Host Validation view from a RunHandle snapshot", () => {
    const validation = Object.freeze({
      snapshot: Object.freeze({ runId: "run-1", revision: 7 }),
      counts: Object.freeze([
        Object.freeze({ state: "satisfied" as const, count: 1 }),
      ]),
      activeChecks: 0,
      gateStatus: "completion_eligible" as const,
      safeReasons: Object.freeze(["validation_completion_eligible"]),
      updatedAt: NOW,
    });
    const projection = apply(initialProjection(), runOperationUpdate(1, {
      sequence: 1,
      runRevision: 3,
      validation,
    }));

    expect(projection.validation).toEqual(validation);
    expect(JSON.stringify(projection.validation)).not.toContain("evidence");
    expect(JSON.stringify(projection.validation)).not.toContain("command");
  });

  it("projects canonical Action attempt and settlement without executor payload", () => {
    let projection = apply(initialProjection(), runtimeUpdate(1, "run.started", {
      status: "running",
      activeAgentId: "agent-1",
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
      activeAgentId: "agent-1",
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
      activeAgentId: "agent-1",
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
      { status: "running", activeAgentId: "agent-child" },
      "run-child",
      childLineage,
    ));
    expect(projection.status).toBe("starting");
    expect(reduceHostRunProjection(
      projection,
      runtimeUpdate(2, "run.started", {
        status: "running",
        activeAgentId: "foreign-agent",
      }, "run-foreign"),
    )).toMatchObject({ status: "rejected", code: "run_tree_root_mismatch" });

    projection = apply(projection, runOperationUpdate(2, {
      sequence: 1,
      runTree: treeWithChild(2),
    }));
    expect(projection.runTree).toMatchObject({
      revision: 2,
      totalDescendantRuns: 1,
      activeDescendantRuns: 1,
      nodes: [
        { runId: "run-1", depth: 0 },
        { runId: "run-child", depth: 1, status: "running" },
      ],
    });
    expect(JSON.stringify(projection.runTree)).not.toContain("delegated prompt");

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
      plan: null,
      retry: null,
      validation: null,
      pendingInteractions: [],
      runTree: rootTree(),
      result: null,
      ...overrides,
    },
  };
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
      }),
    ]),
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
