import { describe, expect, it, vi } from "vitest";
import type { ApprovalReviewInput } from "@agent-anything/permission";
import type { RuntimeEvent, RuntimeEventName } from "@agent-anything/agent-core/events";
import {
  createFailedRunResult,
  createSucceededRunResult,
} from "@agent-anything/agent-core/run";
import {
  createHostRunProjection,
  createHostTerminalRunProjection,
  HOST_RETRY_EVENT_LIMIT,
  type HostRunProjection,
  type HostRunProjectionUpdate,
} from "./HostRunProjection.js";
import {
  createHostRunProjectionStore,
  reduceHostRunProjection,
} from "./HostRunProjectionReducer.js";

const now = "2026-07-17T00:00:00.000Z";
const later = "2026-07-17T00:00:01.000Z";

describe("HostRunProjectionReducer", () => {
  it("projects start, user approval submission, resolution, and terminal result in order", () => {
    let projection = initialProjection();
    projection = apply(projection, runtimeUpdate(1, "run.started", {
      runId: "run-1",
      agentId: "agent-private",
    }));
    projection = apply(projection, runtimeUpdate(2, "approval.requested", {
      runId: "run-1",
      requestId: "approval-1",
      actionId: "action-1",
      actionFingerprint: sha("a"),
      category: "networkAccess",
      pendingVersion: 1,
      reviewer: "user",
      phase: "reviewing",
      reviewOperationId: "review-operation-1",
    }));

    expect(projection).toMatchObject({
      sequence: 2,
      status: "waiting_for_approval",
      approval: {
        requestId: "approval-1",
        phase: "reviewing",
        review: null,
      },
    });

    projection = apply(projection, {
      kind: "approval_review_available",
      runId: "run-1",
      sequence: 3,
      occurredAt: now,
      review: approvalReview(),
    });
    projection = apply(projection, {
      kind: "approval_submission_accepted",
      runId: "run-1",
      sequence: 4,
      occurredAt: now,
      receipt: {
        status: "accepted_for_resolution",
        submissionId: "submission-1",
        runId: "run-1",
        requestId: "approval-1",
        pendingVersion: 1,
      },
    });

    expect(projection.approval).toMatchObject({
      phase: "submitted_for_resolution",
      review: { request: { payload: { host: "example.com" } } },
    });
    expect(projection.status).toBe("waiting_for_approval");
    expect(Object.isFrozen(projection.approval)).toBe(true);

    projection = apply(projection, runtimeUpdate(5, "approval.resolved", {
      runId: "run-1",
      requestId: "approval-1",
      actionId: "action-1",
      pendingVersion: 1,
      reviewer: "user",
      resolutionKind: "decided",
      decisionKind: "accept",
      applicationKind: "action_authority",
      code: null,
      authorityRecordIds: [],
    }));
    expect(projection).toMatchObject({ status: "running", approval: null });

    const terminal = createHostTerminalRunProjection({
      runResult: createSucceededRunResult({
        runId: "run-1",
        taskId: "task-1",
        metadata: {
          completedAt: later,
          durationMs: 1_000,
          iterations: 2,
          actions: 1,
          privatePrompt: "must not survive",
        },
      }, { summary: "private final output" }),
    });
    projection = apply(projection, {
      kind: "terminal_result",
      runId: "run-1",
      sequence: 6,
      occurredAt: later,
      terminal,
    });

    expect(projection).toMatchObject({
      status: "completed",
      terminal: {
        code: null,
        durationMs: 1_000,
        iterations: 2,
        actions: 1,
      },
    });
    expect(JSON.stringify(projection)).not.toContain("private");
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("keeps a complete bounded Plan projection and rejects version regression", () => {
    let projection = apply(
      initialProjection(),
      runtimeUpdate(1, "run.started", { runId: "run-1" }),
    );
    projection = apply(projection, runtimeUpdate(2, "plan.created", {
      runId: "run-1",
      plan: {
        id: "plan-1",
        version: 1,
        status: "active",
        steps: [{ step: "Inspect files", status: "in_progress" }],
        explanation: "private explanation",
        metadata: { prompt: "private prompt" },
      },
    }));
    projection = apply(projection, runtimeUpdate(3, "plan.updated", {
      runId: "run-1",
      previousVersion: 1,
      transition: "updated",
      plan: {
        id: "plan-1",
        version: 2,
        status: "active",
        steps: [
          { step: "Inspect files", status: "completed" },
          { step: "Run tests", status: "in_progress" },
        ],
      },
    }));

    expect(projection.plan).toEqual({
      id: "plan-1",
      version: 2,
      status: "active",
      steps: [
        { step: "Inspect files", status: "completed" },
        { step: "Run tests", status: "in_progress" },
      ],
    });
    expect(JSON.stringify(projection.plan)).not.toContain("private");

    const regression = reduceHostRunProjection(
      projection,
      runtimeUpdate(4, "plan.updated", {
        runId: "run-1",
        previousVersion: 0,
        transition: "updated",
        plan: {
          id: "plan-1",
          version: 1,
          status: "active",
          steps: [{ step: "Old step", status: "in_progress" }],
        },
      }),
    );
    expect(regression).toMatchObject({
      status: "rejected",
      code: "plan_version_regression",
      projection: { sequence: 3 },
    });
  });

  it("retains bounded Retry progress and honest disabled-enforcement outcome", () => {
    let projection = apply(
      initialProjection(),
      runtimeUpdate(1, "run.started", { runId: "run-1" }),
    );

    for (let index = 1; index <= HOST_RETRY_EVENT_LIMIT + 2; index += 1) {
      projection = apply(projection, runtimeUpdate(index + 1, "retry.attempt.started", {
        type: "retry_attempt_started",
        runId: "run-1",
        operationId: `operation-${index}`,
        owner: "provider_request",
        occurredAt: now,
        attemptId: `attempt-${index}`,
        budgetId: `budget-${index}`,
        attemptNumber: index,
        budgetAttemptNumber: 1,
        maxBudgetAttempts: 1,
        rawProviderError: "private retry details",
      }));
    }

    expect(projection.retry).toMatchObject({
      attemptCount: HOST_RETRY_EVENT_LIMIT + 2,
      omittedEventCount: 2,
    });
    expect(projection.retry?.recentEvents).toHaveLength(HOST_RETRY_EVENT_LIMIT);
    expect(JSON.stringify(projection.retry)).not.toContain("private");

    const startedSequence = HOST_RETRY_EVENT_LIMIT + 4;
    projection = apply(projection, runtimeUpdate(startedSequence, "sandbox.attempt.started", {
      runId: "run-1",
      actionId: "action-1",
      attemptId: "sandbox-attempt-1",
      ordinal: 1,
      enforcement: "disabled",
      policyEnvelope: { secret: true },
    }));
    projection = apply(projection, runtimeUpdate(startedSequence + 1, "sandbox.attempt.resolved", {
      runId: "run-1",
      actionId: "action-1",
      attemptId: "sandbox-attempt-1",
      ordinal: 1,
      enforcement: "disabled",
      outcome: "executed",
      code: null,
      enforcementEvidence: { providerId: "private" },
    }));

    expect(projection.enforcement).toEqual({
      selected: "disabled",
      status: "unisolated",
      attemptCount: 1,
      escalationCount: 0,
      latestAttempt: {
        attemptId: "sandbox-attempt-1",
        actionId: "action-1",
        ordinal: 1,
        enforcement: "disabled",
        outcome: "executed",
        code: null,
      },
    });
    expect(JSON.stringify(projection.enforcement)).not.toContain("private");
  });

  it("projects failed terminal results without error messages, metadata, or final output", () => {
    const result = createFailedRunResult(
      {
        runId: "run-1",
        taskId: "task-1",
        metadata: {
          completedAt: later,
          durationMs: 1_000,
          iterations: 1,
          actions: 0,
          prompt: "private prompt",
        },
      },
      "provider_request_failed",
      [{
        owner: "provider",
        code: "provider_request_failed",
        message: "private provider failure",
        retryable: true,
        metadata: { credential: "private credential" },
      }],
    );
    const terminal = createHostTerminalRunProjection({ runResult: result });

    expect(terminal).toMatchObject({
      status: "failed",
      code: "provider_request_failed",
      errors: [{
        owner: "provider",
        code: "provider_request_failed",
        retryable: true,
      }],
    });
    expect(JSON.stringify(terminal)).not.toContain("private");
    expect(JSON.stringify(terminal)).not.toContain("credential");
  });

  it("rejects stale, cross-Run, and post-terminal updates without mutation", () => {
    const initial = initialProjection();
    const started = apply(initial, runtimeUpdate(1, "run.started", { runId: "run-1" }));

    expect(reduceHostRunProjection(
      started,
      runtimeUpdate(1, "task.started", { runId: "run-1" }),
    )).toMatchObject({ status: "rejected", code: "stale_sequence" });
    expect(reduceHostRunProjection(started, {
      ...runtimeUpdate(2, "task.started", { runId: "run-2" }),
      runId: "run-2",
    })).toMatchObject({ status: "rejected", code: "run_identity_mismatch" });

    const terminal = createHostTerminalRunProjection({
      runResult: createSucceededRunResult(
        { runId: "run-1", taskId: "task-1" },
        { summary: "done" },
      ),
      completedAt: later,
    });
    const completed = apply(started, {
      kind: "terminal_result",
      runId: "run-1",
      sequence: 2,
      occurredAt: later,
      terminal,
    });
    const postTerminal = reduceHostRunProjection(
      completed,
      runtimeUpdate(3, "task.completed", { runId: "run-1" }),
    );
    expect(postTerminal).toMatchObject({
      status: "rejected",
      code: "invalid_transition",
      projection: { sequence: 2, status: "completed" },
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

    const result = store.apply(runtimeUpdate(1, "run.started", { runId: "run-1" }));

    expect(result).toMatchObject({ status: "applied", projection: { status: "running" } });
    expect(onListenerFailure).toHaveBeenCalledWith({
      runId: "run-1",
      sequence: 1,
      error: listenerFailure,
    });
    expect(delivered).toHaveBeenCalledWith(store.getProjection());
    expect(store.getProjection().status).toBe("running");

    store.apply(runtimeUpdate(1, "task.started", { runId: "run-1" }));
    expect(delivered).toHaveBeenCalledTimes(1);
  });
});

function initialProjection(): HostRunProjection {
  return createHostRunProjection({
    sessionId: "session-1",
    taskId: "task-1",
    runId: "run-1",
    startedAt: now,
    enforcement: "disabled",
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

function runtimeUpdate(
  sequence: number,
  name: RuntimeEventName,
  payload: Record<string, unknown>,
): HostRunProjectionUpdate {
  return {
    kind: "runtime_event",
    runId: "run-1",
    sequence,
    occurredAt: now,
    event: {
      id: `event-${sequence}`,
      name,
      taskId: "task-1",
      sequence,
      timestamp: now,
      payload,
    } as RuntimeEvent,
  };
}

function approvalReview(): ApprovalReviewInput {
  return {
    request: {
      id: "approval-1",
      runId: "run-1",
      actionId: "action-1",
      actionFingerprint: sha("a"),
      category: "networkAccess",
      reason: "Allow a network request.",
      subject: {
        runId: "run-1",
        actionId: "action-1",
        actionFingerprint: sha("a"),
        environmentId: "environment-1",
        applicabilityKeyCount: 1,
      },
      payload: {
        host: "example.com",
        port: 443,
        protocol: "https",
        actionSummary: "Connect to example.com.",
      },
      decisionOptions: [
        {
          id: "accept",
          kind: "accept",
          scope: "action",
          label: "Allow",
          description: null,
        },
        {
          id: "decline",
          kind: "decline",
          scope: null,
          label: "Decline",
          description: null,
        },
      ],
      createdAt: now,
      deadlineAt: later,
    },
    pendingVersion: 1,
    context: {
      workspaceTrustState: "trusted",
      ruleOutcome: "prompt",
      currentAuthority: {
        fileSystemRead: true,
        fileSystemWrite: false,
        network: false,
      },
      annotations: {},
    },
  };
}

function sha(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
