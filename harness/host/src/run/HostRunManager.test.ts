import { describe, expect, it, vi } from "vitest";
import { createAgentInstructions, type Agent } from "@agent-anything/agent-core/agent";
import type { RunInput } from "@agent-anything/agent-core/input";
import type { InteractionRequestRef } from "@agent-anything/interaction/protocol";
import type { RuntimeEvent } from "@agent-anything/observability/events";
import {
  createRunResult,
  type RunSettlementCauseRecord,
} from "@agent-anything/agent-runtime/run";
import type {
  RunConfig,
  RunHandle,
  RunInvocationOptions,
  RunOperationSnapshot,
  Runner,
} from "@agent-anything/agent-runtime/runner";
import { createHostRunManager } from "./HostRunManager.js";
import { createTestRootRunTreeSnapshot } from "../testing/RunTreeTestSnapshot.js";

describe("HostRunManager", () => {
  it("wraps one exact RunHandle and transports one generic Interaction submission", async () => {
    const fixture = createFakeRunner();
    const manager = createHostRunManager({ runner: fixture.runner, now: () => NOW });
    const active = manager.start(startInput());

    expect(fixture.start).toHaveBeenCalledOnce();
    expect(active.runId).toBe("run-1");
    expect(active.getProjection().status).toBe("starting");
    fixture.publishRuntimeEvent(runStartedEvent());
    fixture.publishSnapshot({
      sequence: 1,
      status: "waiting",
      pendingInteractions: [{
        envelope: {
          request: REQUEST,
          presentation: { title: "Approve Action" },
          disclosureClass: "public",
          expiresAt: null,
        },
        blockingScope: "run",
      }],
    });
    expect(active.getProjection()).toMatchObject({
      status: "waiting",
      pendingInteractions: [{ phase: "pending", request: REQUEST }],
    });

    const submission = active.submitInteraction({
      request: REQUEST,
      submissionId: "submission-1",
      payload: { choice: "approve" },
    });

    expect(submission).toMatchObject({ status: "accepted_for_resolution" });
    expect(fixture.submitInteraction).toHaveBeenCalledWith({
      request: REQUEST,
      submissionId: "submission-1",
      contentDigest: "sha256:11e8eebafd9a704fe24ef6fcc44050ff9b1d28c0a0a51473f88473b2980d3dd4",
      payload: { choice: "approve" },
      receivedAt: NOW,
    });
    expect(active.getProjection().pendingInteractions[0]?.phase)
      .toBe("submitted_for_resolution");

    const exactResult = succeededResult();
    fixture.settle(exactResult);
    const outcome = await active.wait();

    expect(outcome.runResult).toBe(exactResult);
    expect(outcome.terminal).toBe(active.getProjection().terminal);
    expect(active.getResult()).toBe(outcome);
    expect(manager.listRuns()).toEqual([{
      runId: "run-1",
      sessionId: "session-1",
      lifecycle: "settled",
    }]);
    expect(manager.releaseRun("run-1")).toEqual({ status: "released", runId: "run-1" });
  });

  it("keeps cancellation acceptance separate from terminal settlement", () => {
    const fixture = createFakeRunner();
    const manager = createHostRunManager({ runner: fixture.runner, now: () => NOW });
    const active = manager.start(startInput());

    const receipt = active.cancel({ origin: "user", reasonCode: "user_requested" });

    expect(receipt).toEqual({
      status: "accepted",
      cancellation: {
        requestId: "cancellation-1",
        origin: "user",
        reasonCode: "user_requested",
        requestedAt: NOW,
      },
    });
    expect(active.getProjection()).toMatchObject({
      status: "cancelling",
      terminal: null,
      cancellation: { requestId: "cancellation-1" },
    });
    expect(manager.releaseRun("run-1")).toEqual({ status: "run_active", runId: "run-1" });
  });

  it("forwards steering with Host time and exposes the current status projection", () => {
    const fixture = createFakeRunner();
    const manager = createHostRunManager({ runner: fixture.runner, now: () => NOW });
    const active = manager.start(startInput());
    fixture.publishSnapshot({ sequence: 1, runRevision: 3, status: "running" });

    const receipt = active.steer({
      commandId: "steering-1",
      expectedRunRevision: 3,
      instruction: "Inspect the failing tests first.",
      attribution: { origin: "user", actorId: "user-1" },
    });

    expect(receipt).toMatchObject({ status: "accepted_for_application" });
    expect(fixture.steer).toHaveBeenCalledWith({
      commandId: "steering-1",
      expectedRunRevision: 3,
      instruction: "Inspect the failing tests first.",
      attribution: { origin: "user", actorId: "user-1" },
      submittedAt: NOW,
    });
    expect(active.getStatus()).toBe(active.getProjection());
    expect(active.getStatus().runRevision).toBe(3);
  });

  it("routes exact descendant resume through the owned RunHandle", () => {
    const fixture = createFakeRunner();
    const manager = createHostRunManager({ runner: fixture.runner, now: () => NOW });
    const active = manager.start(startInput());
    const route = {
      request: { id: "delegation-request-1", revision: "1" },
      relation: { id: "descendant-relation-1" },
      child: { id: "child-run-1" },
      resume: {
        id: "resume-1",
        expectedRunRevision: 7,
        suspension: {
          run: { id: "child-run-1" },
          id: "child-suspension-1",
          revision: "7",
        },
        origin: "host" as const,
        reason: "Resume the exact suspended Child.",
      },
    };

    expect(active.resumeDescendant(route)).toMatchObject({
      status: "routed",
      child: { id: "child-run-1" },
      resume: { status: "accepted" },
    });
    expect(fixture.resumeDescendant).toHaveBeenCalledWith(route);
  });

  it("rejects duplicate Runner-created Run identity without replacing the original", () => {
    const first = createFakeRunner();
    const second = createFakeHandle("run-1");
    first.start.mockImplementationOnce(() => first.handle).mockImplementationOnce(() => second.handle);
    const manager = createHostRunManager({ runner: first.runner, now: () => NOW });
    const original = manager.start(startInput());

    expect(() => manager.start({ ...startInput(), sessionId: "session-2" }))
      .toThrow("already registered");
    expect(manager.getRun("run-1")).toBe(original);
    expect(second.cancel).toHaveBeenCalledWith({
      origin: "host",
      reasonCode: "host_requested",
      reason: "Duplicate Host Run identity.",
    });
  });
});

function createFakeRunner() {
  const fixture = createFakeHandle("run-1");
  let options: RunInvocationOptions | null = null;
  const start = vi.fn((
    _agent: Agent,
    _input: RunInput,
    _config: RunConfig,
    invocation: RunInvocationOptions,
  ) => {
    options = invocation;
    return fixture.handle;
  });
  return {
    ...fixture,
    start,
    runner: { start } as unknown as Runner,
    publishRuntimeEvent(event: RuntimeEvent) {
      options?.runtimeEventPublisher?.publish(event);
    },
  };
}

function createFakeHandle(runId: string) {
  let snapshot: RunOperationSnapshot = {
    runId,
    sequence: 0,
    runRevision: 0,
    status: "initializing",
    lastRunItemSequence: 0,
    instructionBinding: null,
    plan: null,
    suspension: null,
    retry: null,
    pendingInteractions: [],
    activeDelegations: [],
    continuationTargets: [],
    verification: null,
    runTree: rootTree(runId),
    result: null,
  };
  const listeners = new Set<(value: RunOperationSnapshot) => void>();
  let result: ReturnType<typeof succeededResult> | null = null;
  let resolve!: (value: ReturnType<typeof succeededResult>) => void;
  const completion = new Promise<ReturnType<typeof succeededResult>>((settle) => {
    resolve = settle;
  });
  const cancel = vi.fn(() => ({
    accepted: true,
    status: "accepted" as const,
    request: {
      id: "cancellation-1",
      runId,
      origin: "user" as const,
      reasonCode: "user_requested" as const,
      reason: null,
      approvalRequestId: null,
      parentRunId: null,
      requestedAt: NOW,
    },
  }));
  const submitInteraction = vi.fn(() => ({
    status: "accepted_for_resolution" as const,
    receipt: {
      receiptId: "interaction-receipt-1",
      request: REQUEST,
      submissionId: "submission-1",
      status: "accepted_for_resolution" as const,
      recordedAt: NOW,
    },
  }));
  const steer = vi.fn((input: Parameters<RunHandle["steer"]>[0]) => ({
    status: "accepted_for_application" as const,
    command: {
      ...input,
      ref: { run: { id: runId }, commandId: input.commandId },
      acceptedRunRevision: input.expectedRunRevision,
    },
  }));
  const resumeDescendant = vi.fn((input: Parameters<RunHandle["resumeDescendant"]>[0]) => ({
    status: "routed" as const,
    relation: input.relation,
    child: input.child,
    resume: {
      status: "accepted" as const,
      request: {
        ...input.resume,
        run: input.child,
        requestedAt: NOW,
      },
      currentRunRevision: input.resume.expectedRunRevision + 1,
    },
  }));
  const handle: RunHandle = {
    runId,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    cancel,
    resume: vi.fn(() => ({ status: "not_suspended" as const })),
    steer,
    steerDescendant: vi.fn(() => ({ status: "not_found" as const })),
    resumeDescendant,
    submitInteraction,
    wait: () => completion,
    getResult: () => result,
  };
  return {
    handle,
    cancel,
    steer,
    resumeDescendant,
    submitInteraction,
    publishSnapshot(overrides: Partial<RunOperationSnapshot>) {
      snapshot = Object.freeze({ ...snapshot, ...overrides });
      for (const listener of listeners) listener(snapshot);
    },
    settle(value: ReturnType<typeof succeededResult>) {
      result = value;
      snapshot = Object.freeze({
        ...snapshot,
        sequence: snapshot.sequence + 1,
        status: "succeeded",
        pendingInteractions: [],
        result: value,
      });
      for (const listener of listeners) listener(snapshot);
      resolve(value);
    },
  };
}

function startInput() {
  return {
    sessionId: "session-1",
    agent: {
      id: "agent-1",
      revision: "1",
      name: "Test Agent",
      instructions: testAgentInstructions("agent-1"),
      output: { validate: () => ({ valid: true as const, output: { summary: "done" } }) },
      metadata: {},
    },
    runInput: {
      task: {
        id: "task-1",
        kind: "test.task",
        input: {},
        createdAt: NOW,
        metadata: {},
      },
      items: [],
      metadata: {},
    },
    runConfig: {
      permissions: { permissionProfile: { enforcement: "disabled" } },
    } as unknown as RunConfig,
  };
}

function testAgentInstructions(agentId: string) {
  return createAgentInstructions({
    id: `${agentId}.instructions`,
    release: { id: `${agentId}.release`, revision: "1" },
    model: { providerId: "test-provider", modelId: "test-model" },
    resolverRevision: "test-resolver.v1",
    blocks: [{
      id: "behavior",
      source: { owner: "test", kind: "instruction_source", id: `${agentId}.behavior`, revision: "1" },
      content: "Complete the task.",
    }],
  });
}

function runStartedEvent(): RuntimeEvent {
  return Object.freeze({
    schemaVersion: 2,
    id: "event-1",
    runId: "run-1",
    taskId: "task-1",
    lineage: Object.freeze({
      kind: "root" as const,
      root: Object.freeze({ id: "run-1" }),
      depth: 0 as const,
    }),
    sequence: 1,
    name: "run.started",
    occurredAt: NOW,
    payload: Object.freeze({
      status: "running",
      activeAgentId: "agent-1",
      activeAgentRevision: "1",
      instructionBindingId: "run-1:agent-instruction-binding:0",
      instructionBindingRevision: `sha256:${"0".repeat(64)}`,
    }),
  });
}

function rootTree(runId: string): RunOperationSnapshot["runTree"] {
  return createTestRootRunTreeSnapshot(runId, NOW);
}

function succeededResult() {
  const cause = Object.freeze({
    ref: Object.freeze({
      run: Object.freeze({ id: "run-1" }),
      id: "run-1:settlement-cause:1",
      revision: "1",
    }),
    kind: "completion" as const,
    code: "completion_accepted" as const,
    source: Object.freeze({
      owner: "agent-runtime",
      kind: "controller_decision",
      id: "controller-turn-1",
      revision: "1",
      run: Object.freeze({ id: "run-1" }),
    }),
    underlying: Object.freeze([]),
    omittedUnderlyingCount: 0,
    recordedAt: LATER,
  }) satisfies RunSettlementCauseRecord;
  return createRunResult({
    runId: "run-1",
    taskId: "task-1",
    startingAgent: { id: "agent-1", revision: "1" },
    finalActiveAgent: { id: "agent-1", revision: "1" },
    startingInstructionBinding: instructionBindingRef("run-1"),
    finalInstructionBinding: instructionBindingRef("run-1"),
    startedAt: NOW,
    settlement: Object.freeze({
      status: "succeeded" as const,
      completedAt: LATER,
      cause: cause.ref,
      output: Object.freeze({ summary: "done" }),
    }),
    cause,
    settlementCauses: Object.freeze([cause]),
  });
}

function instructionBindingRef(runId: string) {
  return Object.freeze({
    id: `${runId}:agent-instruction-binding:0`,
    revision: `sha256:${"0".repeat(64)}`,
  });
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
