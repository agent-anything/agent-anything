import { describe, expect, it } from "vitest";
import type { ControllerFinishedRuntimeEventPayload } from "../events/RuntimeEventPayload.js";
import { RuntimeEventStream } from "../events/RuntimeEventStream.js";
import {
  RUN_TRACE_SCHEMA_VERSION,
  type RunTrace,
  type RunTraceObserver,
} from "./RunTrace.js";
import { RunTraceAssembler } from "./RunTraceAssembler.js";

describe("RunTraceAssembler", () => {
  it("assembles the reusable Run, Controller, Operation, and Interaction catalog", () => {
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
    }, STARTED_AT);
    stream.emit("context.transition.committed", {
      transitionId: "transition-1",
      activeContextId: "context-1",
      baseVersion: 0,
      committedVersion: 1,
      proposerOwner: "agent-core",
      proposerKind: "run_execution",
      causeKind: "run_initialization",
      causeId: "run-1",
      correlationId: "run-1",
      operationKinds: ["add"],
    }, STARTED_AT);
    stream.emit("context.projection.completed", {
      manifestId: "manifest-1",
      projectionId: "projection-1",
      requestId: "request-1",
      activeContextId: "context-1",
      activeContextVersion: 1,
      profileId: "profile-1",
      profileRevision: "1",
      policyId: "policy-1",
      policyRevision: "1",
      estimatorId: "estimator-1",
      estimatorRevision: "1",
      accountingUnit: "bytes",
      budgetMaximum: 1_024,
      consideredItemCount: 1,
      projectedItemCount: 1,
      projectedAmount: 128,
      includedCount: 1,
      transformedCount: 0,
      referencedCount: 0,
      omittedCount: 0,
      rejectedCount: 0,
      blockedCount: 0,
      outcome: "projected",
      code: null,
    }, STARTED_AT);
    stream.emit("controller.started", {
      turnId: "turn-1",
      iteration: 1,
    }, STARTED_AT);
    stream.emit("controller.tool_exposure.resolved", {
      turnId: "turn-1",
      iteration: 1,
      controllerRequestId: "request-1",
      manifestId: "manifest-1",
      selectionRevision: "selection-1",
      contentRevision: "content-1",
      basisRevision: "basis-1",
      proofId: "proof-1",
      catalogRevision: "catalog-1",
      exposedToolCount: 2,
      omittedToolCount: 1,
      omissionReasons: ["resource_exhausted"],
    }, STARTED_AT);
    stream.emit("controller.finished", {
      turnId: "turn-1",
      iteration: 1,
      status: "decided",
      code: null,
      decisionKind: "advance",
    }, COMPLETED_AT);
    stream.emit("operation.started", {
      invocationId: "operation-invocation-1",
      operationNamespace: "code",
      operationName: "read-file",
      operationRevision: "1",
      semanticOwner: "code-agent",
      bindingKind: "direct",
      correlationKind: "run_action",
      parentInvocationId: null,
      parentRunActionId: "run-action-1",
    }, STARTED_AT);
    stream.emit("operation.finished", {
      invocationId: "operation-invocation-1",
      status: "succeeded",
      code: null,
      resultId: "operation-result-1",
      lowerResultRefs: ["action-settlement-1"],
    }, COMPLETED_AT);
    stream.emit("interaction.opened", {
      requestId: "interaction-1",
      protocolOwner: "permission",
      protocolKind: "approval",
      protocolRevision: "1",
      subjectOwner: "canonical-action",
      subjectKind: "action-subject",
      subjectId: "action-1",
      subjectRevision: "1",
      blockingScope: "run",
      pendingVersion: 1,
      parentRunActionId: "run-action-1",
    }, STARTED_AT);
    stream.emit("interaction.settled", {
      requestId: "interaction-1",
      pendingVersion: 1,
      lifecycle: "resolved",
      code: null,
      terminalRecordId: "interaction-terminal-1",
    }, COMPLETED_AT);
    stream.emit("validation.check.started", {
      snapshotRevision: 4,
      attemptId: "validation-attempt-1",
      requirementId: "requirement-1",
      origin: "trusted_automatic",
    }, STARTED_AT);
    stream.emit("validation.check.finished", {
      snapshotRevision: 5,
      attemptId: "validation-attempt-1",
      status: "completed",
      code: null,
      durationMs: 25,
      coverageRatio: 1,
    }, COMPLETED_AT);
    stream.emit("validation.assessment.committed", {
      snapshotRevision: 7,
      requirementId: "requirement-1",
      assessmentId: "assessment-1",
      verdict: "satisfied",
    }, COMPLETED_AT);
    stream.emit("validation.gate.evaluated", {
      snapshotRevision: 8,
      gateId: "gate-1",
      status: "completion_eligible",
      disposition: null,
      reasonCodes: ["validation_completion_eligible"],
    }, COMPLETED_AT);
    stream.emit("run.item.appended", {
      itemId: "item-1",
      itemKind: "run_action",
      itemSequence: 1,
    }, COMPLETED_AT);
    stream.emit("run.completed", {
      status: "succeeded",
      code: null,
      durationMs: 1_000,
      itemCount: 1,
      evidenceCount: 0,
      artifactCount: 0,
      errorCodes: [],
    }, COMPLETED_AT);

    const trace = assembler.complete({
      items: [{
        id: "item-1",
        runId: "run-1",
        sequence: 1,
        kind: "run_action",
        createdAt: COMPLETED_AT,
      }],
      result: terminalResult({ status: "succeeded", code: null, itemCount: 1 }),
    });

    expect(trace).toMatchObject({
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
      status: "complete",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      issues: [],
    });
    expect(trace.spans.map((span) => [span.owner, span.operation, span.status]))
      .toEqual([
        ["runtime", "run", "succeeded"],
        ["controller", "turn", "succeeded"],
        ["operation", "operation", "succeeded"],
        ["interaction", "interaction", "succeeded"],
      ]);
    expect(trace.spans[1]?.attributes.toolExposure).toEqual(expect.objectContaining({
      proofId: "proof-1",
      manifestId: "manifest-1",
      exposedToolCount: 2,
      omittedToolCount: 1,
      omissionReasons: ["resource_exhausted"],
    }));
    expect(trace.spans[0]?.attributes.contextTransitions).toEqual([{
      transitionId: "transition-1",
      activeContextId: "context-1",
      baseVersion: 0,
      committedVersion: 1,
      proposerOwner: "agent-core",
      proposerKind: "run_execution",
      causeKind: "run_initialization",
      causeId: "run-1",
      correlationId: "run-1",
      operationKinds: ["add"],
    }]);
    expect(trace.spans[0]?.attributes.contextProjections).toEqual([expect.objectContaining({
      manifestId: "manifest-1",
      consideredItemCount: 1,
      projectedItemCount: 1,
      outcome: "projected",
      code: null,
    })]);
    expect(trace.spans[0]?.attributes.validation).toEqual([
      {
        event: "check_started",
        snapshotRevision: 4,
        subjectId: "validation-attempt-1",
        status: "running",
        code: null,
        durationMs: null,
        coverageRatio: null,
      },
      {
        event: "check_finished",
        snapshotRevision: 5,
        subjectId: "validation-attempt-1",
        status: "completed",
        code: null,
        durationMs: 25,
        coverageRatio: 1,
      },
      {
        event: "assessment_committed",
        snapshotRevision: 7,
        subjectId: "assessment-1",
        status: "satisfied",
        code: null,
        durationMs: null,
        coverageRatio: null,
      },
      {
        event: "gate_evaluated",
        snapshotRevision: 8,
        subjectId: "gate-1",
        status: "completion_eligible",
        code: "validation_completion_eligible",
        durationMs: null,
        coverageRatio: null,
      },
    ]);
    expect(trace.spans[2]).toMatchObject({
      parentSpanId: trace.rootSpanId,
      operationId: "operation-invocation-1",
      attributes: {
        semanticOwner: "code-agent",
        resultId: "operation-result-1",
        resultStatus: "succeeded",
      },
      links: expect.arrayContaining([{
        kind: "operation_result",
        id: "operation-result-1",
      }]),
    });
    expect(trace.spans[0]?.links).toEqual(expect.arrayContaining([
      { kind: "run_item", id: "item-1" },
      { kind: "run_result", id: "run-1" },
    ]));
    expect(Object.isFrozen(trace)).toBe(true);
    expect(Object.isFrozen(trace.spans)).toBe(true);
    expect(observed.at(-1)).toBe(trace);
  });

  it("retains a Controller settlement without a start as an explicit unknown span", () => {
    const assembler = createAssembler();
    const stream = createStream(assembler);
    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, STARTED_AT);
    stream.emit("controller.finished", {
      turnId: "turn-1",
      iteration: 1,
      status: "failed",
      code: "controller_failed",
      decisionKind: null,
    }, COMPLETED_AT);
    stream.emit("run.failed", terminalEvent("failed", "controller_failed"), COMPLETED_AT);

    const trace = assembler.complete({
      items: [],
      result: terminalResult({ status: "failed", code: "controller_failed" }),
    });

    expect(trace.status).toBe("incomplete");
    expect(trace.issues).toContainEqual({
      code: "operation_start_missing",
      sourceId: "event-2",
      operationId: "controller-turn:1",
    });
    expect(trace.spans[1]).toMatchObject({
      owner: "controller",
      status: "unknown",
      startedAt: null,
      completedAt: COMPLETED_AT,
    });
  });

  it("marks an open Operation unknown when terminal assembly lacks settlement", () => {
    const assembler = createAssembler();
    const stream = createStream(assembler);
    stream.emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, STARTED_AT);
    stream.emit("operation.started", {
      invocationId: "operation-invocation-1",
      operationNamespace: "code",
      operationName: "search",
      operationRevision: "1",
      semanticOwner: "code-agent",
      bindingKind: "internal",
      correlationKind: "run_action",
      parentInvocationId: null,
      parentRunActionId: "run-action-1",
    }, STARTED_AT);
    stream.emit("run.failed", terminalEvent("failed", "runtime_failed"), COMPLETED_AT);

    const trace = assembler.complete({
      items: [],
      result: terminalResult({ status: "failed", code: "runtime_failed" }),
    });

    expect(trace.issues).toContainEqual({
      code: "operation_settlement_missing",
      sourceId: null,
      operationId: "operation-invocation-1",
    });
    expect(trace.spans[1]).toMatchObject({
      owner: "operation",
      status: "unknown",
      startedAt: STARTED_AT,
      completedAt: null,
    });
  });

  it("rejects foreign and regressed events without replacing accepted facts", () => {
    const assembler = createAssembler();
    createStream(assembler).emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, STARTED_AT);
    const foreign = createStream(undefined, "run-2").emit("controller.started", {
      turnId: "foreign-turn",
      iteration: 1,
    }, COMPLETED_AT);
    assembler.publish(foreign);
    const regressed = createStream(undefined).emit("run.started", {
      status: "running",
      activeAgentId: "different-agent",
    }, COMPLETED_AT);
    assembler.publish(regressed);

    const trace = assembler.getSnapshot();
    expect(trace.spans[0]?.attributes).toMatchObject({ activeAgentId: "agent-1" });
    expect(trace.issues.map((issue) => issue.code)).toEqual([
      "run_identity_mismatch",
      "event_sequence_regression",
    ]);
  });

  it("accepts a later ordered event only with an explicit sequence-gap issue", () => {
    const assembler = createAssembler();
    createStream(assembler).emit("run.started", {
      status: "running",
      activeAgentId: "agent-1",
    }, STARTED_AT);
    const source = createStream(undefined);
    source.emit("run.started", { status: "running", activeAgentId: "agent-1" });
    source.emit("run.item.appended", {
      itemId: "item-ignored",
      itemKind: "state_transition",
      itemSequence: 1,
    });
    const later = source.emit("controller.started", {
      turnId: "turn-1",
      iteration: 1,
    });

    assembler.publish(later);

    expect(assembler.getSnapshot().issues).toContainEqual({
      code: "event_sequence_gap",
      sourceId: "event-3",
      operationId: null,
    });
    expect(assembler.getSnapshot().spans[1]).toMatchObject({
      operationId: "controller-turn:1",
      status: "running",
    });
  });

  it("redacts undeclared Product data and isolates every observer", async () => {
    const observed: RunTrace[] = [];
    const observers: RunTraceObserver[] = [
      { observe() { throw new Error("sync observer failed"); } },
      { observe() { return Promise.reject(new Error("async observer failed")); } },
      { observe(trace) { observed.push(trace); } },
    ];
    const assembler = createAssembler(observers);
    const stream = createStream(assembler);

    stream.emit("controller.started", { turnId: "turn-1", iteration: 1 }, STARTED_AT);
    stream.emit("controller.finished", {
      turnId: "turn-1",
      iteration: 1,
      status: "decided",
      code: null,
      decisionKind: "propose_completion",
      rawPrompt: "secret",
    } as ControllerFinishedRuntimeEventPayload, COMPLETED_AT);
    await Promise.resolve();

    expect(observed).toHaveLength(2);
    const span = observed.at(-1)?.spans[1];
    expect(span?.attributes).toEqual({
      turnId: "turn-1",
      iteration: 1,
      decisionKind: "propose_completion",
      code: null,
      toolExposure: null,
    });
    expect(span?.attributes).not.toHaveProperty("rawPrompt");
    expect(Object.isFrozen(span?.attributes)).toBe(true);
  });

  it("retains one immutable descendant lineage and reports conflicting lineage", () => {
    const lineage = {
      kind: "descendant" as const,
      root: { id: "run-root" },
      parent: { id: "run-parent" },
      parentRunAction: { run: { id: "run-parent" }, id: "action-1", sequence: 1 },
      relation: { id: "relation-1" },
      depth: 2,
    };
    const assembler = new RunTraceAssembler({
      traceId: "trace-child",
      runId: "run-child",
      taskId: "task-1",
      lineage,
      createSpanId: ({ sequence }) => `child-span-${sequence}`,
    });
    createStream(assembler, "run-child", lineage).emit("run.started", {
      status: "running",
      activeAgentId: "agent-child",
    });
    lineage.root.id = "mutated";

    expect(assembler.getSnapshot().lineage).toEqual({
      kind: "descendant",
      root: { id: "run-root" },
      parent: { id: "run-parent" },
      parentRunAction: { run: { id: "run-parent" }, id: "action-1", sequence: 1 },
      relation: { id: "relation-1" },
      depth: 2,
    });
    createStream(assembler, "run-child", {
      ...lineage,
      root: { id: "run-root" },
      relation: { id: "relation-conflict" },
    }).emit("controller.started", { turnId: "turn-1", iteration: 1 });
    expect(assembler.getSnapshot().issues).toContainEqual({
      code: "run_lineage_mismatch",
      sourceId: "event-1",
      operationId: null,
    });
  });
});

function createAssembler(
  observers: readonly RunTraceObserver[] = [],
): RunTraceAssembler {
  return new RunTraceAssembler({
    traceId: "trace-1",
    runId: "run-1",
    taskId: "task-1",
    lineage: { kind: "root", root: { id: "run-1" }, depth: 0 },
    createSpanId: ({ sequence }) => `span-${sequence}`,
    observers,
  });
}

function createStream(
  publisher: RunTraceAssembler | undefined,
  runId = "run-1",
  lineage: import("@agent-anything/agent-core/run-tree").RunLineage = {
    kind: "root",
    root: { id: runId },
    depth: 0,
  },
): RuntimeEventStream {
  return new RuntimeEventStream({
    runId,
    taskId: "task-1",
    lineage,
    now: () => STARTED_AT,
    createEventId: ({ sequence }) => `event-${sequence}`,
    publishers: publisher === undefined ? [] : [publisher],
  });
}

function terminalEvent(
  status: "failed" | "blocked" | "cancelled",
  code: string,
) {
  return {
    status,
    code,
    durationMs: 1_000,
    itemCount: 0,
    evidenceCount: 0,
    artifactCount: 0,
    errorCodes: [code],
  } as const;
}

function terminalResult(input: {
  readonly status: "succeeded" | "blocked" | "failed" | "cancelled";
  readonly code: string | null;
  readonly itemCount?: number;
}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    status: input.status,
    code: input.code,
    itemCount: input.itemCount ?? 0,
    evidenceCount: 0,
    artifactCount: 0,
    errorCodes: input.code === null ? [] : [input.code],
  } as const;
}

const STARTED_AT = "2026-08-13T00:00:00.000Z";
const COMPLETED_AT = "2026-08-13T00:00:01.000Z";
