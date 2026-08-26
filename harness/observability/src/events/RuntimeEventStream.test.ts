import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeEventPublisher } from "./RuntimeEvent.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./RuntimeEvent.js";
import type {
  ContextProjectionCompletedRuntimeEventPayload,
  ControllerFinishedRuntimeEventPayload,
  RunProgressAssessedRuntimeEventPayload,
} from "./RuntimeEventPayload.js";
import { RuntimeEventStream } from "./RuntimeEventStream.js";

describe("RuntimeEventStream", () => {
  it("materializes one bounded Run-scoped snapshot before fan-out", () => {
    const first: RuntimeEvent[] = [];
    const second: RuntimeEvent[] = [];
    const stream = createStream([
      { publish: (event) => first.push(event) },
      { publish: (event) => second.push(event) },
    ]);

    const event = stream.emit("controller.finished", {
      turnId: "turn-1",
      iteration: 1,
      status: "decided",
      code: null,
      decisionKind: "advance",
      rawModelOutput: "must-not-escape",
    } as ControllerFinishedRuntimeEventPayload);

    expect(event).toEqual({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      id: "run-1:runtime-event:1",
      runId: "run-1",
      taskId: "task-1",
      lineage: {
        kind: "root",
        root: { id: "run-1" },
        depth: 0,
      },
      sequence: 1,
      name: "controller.finished",
      occurredAt: NOW,
      payload: {
        turnId: "turn-1",
        iteration: 1,
        status: "decided",
        code: null,
        decisionKind: "advance",
      },
    });
    expect(first[0]).toBe(event);
    expect(second[0]).toBe(event);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(event.payload).not.toHaveProperty("rawModelOutput");
  });

  it("copies nested lists and isolates one publisher failure from the next", () => {
    const lowerResultRefs = ["action-settlement-1"];
    const delivered: RuntimeEvent[] = [];
    const stream = createStream([
      {
        publish(event) {
          Object.defineProperty(event.payload, "productTrace", { value: "forbidden" });
        },
      },
      { publish: (event) => delivered.push(event) },
    ]);

    const event = stream.emit("operation.finished", {
      invocationId: "operation-invocation-1",
      status: "succeeded",
      code: null,
      resultId: "operation-result-1",
      lowerResultRefs,
    });
    lowerResultRefs[0] = "mutated";

    expect(delivered).toEqual([event]);
    expect(event.payload.lowerResultRefs).toEqual(["action-settlement-1"]);
    expect(Object.isFrozen(event.payload.lowerResultRefs)).toBe(true);
  });

  it("allocates one monotonic sequence and de-duplicates publisher identity", () => {
    const events: RuntimeEvent[] = [];
    const publisher: RuntimeEventPublisher = {
      publish(event) {
        events.push(event);
      },
    };
    const stream = createStream([publisher, publisher]);

    stream.emit("run.started", {
      status: "running",
      ...runStartedIdentity("agent-1"),
    });
    stream.emit("controller.started", { turnId: "turn-1", iteration: 1 });

    expect(events.map((event) => [event.id, event.sequence])).toEqual([
      ["run-1:runtime-event:1", 1],
      ["run-1:runtime-event:2", 2],
    ]);
  });

  it("publishes only bounded Controller Tool exposure lineage and counts", () => {
    const events: RuntimeEvent[] = [];
    const stream = createStream([{ publish: (event) => events.push(event) }]);

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
      exposedToolCount: 3,
      omittedToolCount: 1,
      omissionReasons: ["resource_exhausted"],
      omittedDescriptors: [{ description: "must-not-escape" }],
    } as never);

    expect(events[0]?.payload).toEqual({
      turnId: "turn-1",
      iteration: 1,
      controllerRequestId: "request-1",
      manifestId: "manifest-1",
      selectionRevision: "selection-1",
      contentRevision: "content-1",
      basisRevision: "basis-1",
      proofId: "proof-1",
      catalogRevision: "catalog-1",
      exposedToolCount: 3,
      omittedToolCount: 1,
      omissionReasons: ["resource_exhausted"],
    });
    expect(events[0]?.payload).not.toHaveProperty("omittedDescriptors");
  });

  it("allowlists bounded Run Progress facts without semantic fingerprints", () => {
    const events: RuntimeEvent[] = [];
    const stream = createStream([{ publish: (event) => events.push(event) }]);
    const factRefs = [{
      kind: "operation_result" as const,
      owner: "workspace",
      subjectId: "file-1",
      revision: "2",
    }];

    stream.emit("run.progress.assessed", {
      checkpointSequence: 2,
      disposition: "repeated",
      reasonCode: "equivalent_fact_repeated",
      factRefs,
      consecutiveNonAdvancingCheckpoints: 2,
      correctionRounds: 1,
      activeCorrectionRound: 1,
      semanticFingerprint: "must-not-escape",
      rawContext: { secret: true },
    } as RunProgressAssessedRuntimeEventPayload);
    factRefs[0]!.revision = "mutated";

    expect(events[0]?.payload).toEqual({
      checkpointSequence: 2,
      disposition: "repeated",
      reasonCode: "equivalent_fact_repeated",
      factRefs: [{
        kind: "operation_result",
        owner: "workspace",
        subjectId: "file-1",
        revision: "2",
      }],
      consecutiveNonAdvancingCheckpoints: 2,
      correctionRounds: 1,
      activeCorrectionRound: 1,
    });
    expect(Object.isFrozen(events[0]?.payload.factRefs)).toBe(true);
    expect(Object.isFrozen(events[0]?.payload.factRefs[0])).toBe(true);
    expect(events[0]?.payload).not.toHaveProperty("semanticFingerprint");
    expect(events[0]?.payload).not.toHaveProperty("rawContext");
  });

  it("snapshots a payload-free Context transition trace record", () => {
    const events: RuntimeEvent[] = [];
    const stream = createStream([{ publish: (event) => events.push(event) }]);

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
    });

    expect(events[0]?.payload).toEqual({
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
    });
    expect(events[0]?.payload).not.toHaveProperty("contributions");
  });

  it("publishes only the bounded Context Manifest summary", () => {
    const events: RuntimeEvent[] = [];
    const stream = createStream([{ publish: (event) => events.push(event) }]);

    stream.emit("context.projection.completed", {
      ...contextProjectionPayload(),
      manifestRecords: [{ payload: "must-not-escape" }],
    } as ContextProjectionCompletedRuntimeEventPayload);

    expect(events[0]?.payload).toEqual(contextProjectionPayload());
    expect(events[0]?.payload).not.toHaveProperty("manifestRecords");
  });

  it("snapshots descendant lineage and bounded relation lifecycle payloads", () => {
    const events: RuntimeEvent[] = [];
    const lineage = {
      kind: "descendant" as const,
      root: { id: "run-root" },
      parent: { id: "run-parent" },
      parentRunAction: { run: { id: "run-parent" }, id: "action-1", sequence: 1 },
      relation: { id: "relation-1" },
      depth: 2,
    };
    const stream = new RuntimeEventStream({
      runId: "run-child",
      taskId: "task-child",
      lineage,
      now: () => NOW,
      createEventId: ({ sequence }) => `child-event-${sequence}`,
      publishers: [{ publish: (event) => events.push(event) }],
    });

    stream.emit("run.descendant.settled", {
      relationId: "relation-next",
      parentRunActionId: "action-next",
      childRunId: "run-grandchild",
      childAgentId: "agent-child",
      childAgentRevision: "agent-child-v1",
      requestId: "request-next",
      requestRevision: "request-next-v1",
      predecessorResultId: "result-previous",
      contextSourceCount: 2,
      authorityDerivationId: "authority-next",
      limitDerivationId: "limits-next",
      depth: 3,
      status: "failed",
      code: "controller_failed",
      resultId: "result-next",
      resultRevision: "result-next-v1",
      expectationPresentCount: 2,
      expectationUnmetCount: 1,
      evidenceCount: 3,
      artifactCount: 1,
      verificationStatus: "inconclusive",
      effectStatus: "partial",
      uncertaintyCount: 2,
      controllerTurns: 4,
      actions: 3,
      modelUsageStatus: "unavailable",
      limitStatus: "within_limits",
      exhaustedLimit: null,
      treeRevision: 9,
      delegatedPrompt: "must-not-escape",
    } as never);
    stream.emit("run.descendant.rejected", {
      relationId: null,
      parentRunActionId: "action-rejected",
      childRunId: null,
      depth: 3,
      code: "descendant_run_active_limit_exceeded",
      treeRevision: 9,
    });
    lineage.root.id = "mutated";

    expect(events[0]?.lineage).toEqual({
      kind: "descendant",
      root: { id: "run-root" },
      parent: { id: "run-parent" },
      parentRunAction: { run: { id: "run-parent" }, id: "action-1", sequence: 1 },
      relation: { id: "relation-1" },
      depth: 2,
    });
    expect(events[0]?.payload).toEqual({
      relationId: "relation-next",
      parentRunActionId: "action-next",
      childRunId: "run-grandchild",
      childAgentId: "agent-child",
      childAgentRevision: "agent-child-v1",
      requestId: "request-next",
      requestRevision: "request-next-v1",
      predecessorResultId: "result-previous",
      contextSourceCount: 2,
      authorityDerivationId: "authority-next",
      limitDerivationId: "limits-next",
      depth: 3,
      status: "failed",
      code: "controller_failed",
      resultId: "result-next",
      resultRevision: "result-next-v1",
      expectationPresentCount: 2,
      expectationUnmetCount: 1,
      evidenceCount: 3,
      artifactCount: 1,
      verificationStatus: "inconclusive",
      effectStatus: "partial",
      uncertaintyCount: 2,
      controllerTurns: 4,
      actions: 3,
      modelUsageStatus: "unavailable",
      limitStatus: "within_limits",
      exhaustedLimit: null,
      treeRevision: 9,
    });
    expect(events[0]?.payload).not.toHaveProperty("delegatedPrompt");
    expect(Object.isFrozen(events[0]?.lineage)).toBe(true);
    expect(events[1]?.payload).toEqual({
      relationId: null,
      parentRunActionId: "action-rejected",
      childRunId: null,
      depth: 3,
      code: "descendant_run_active_limit_exceeded",
      treeRevision: 9,
    });
  });
});

function contextProjectionPayload(): ContextProjectionCompletedRuntimeEventPayload {
  return {
    manifestId: "manifest-1",
    projectionId: "projection-1",
    requestId: "request-1",
    activeContextId: "context-1",
    activeContextVersion: 2,
    profileId: "profile-1",
    profileRevision: "1",
    policyId: "policy-1",
    policyRevision: "1",
    estimatorId: "estimator-1",
    estimatorRevision: "1",
    accountingUnit: "bytes",
    budgetMaximum: 1_024,
    consideredItemCount: 4,
    projectedItemCount: 2,
    projectedAmount: 512,
    includedCount: 1,
    transformedCount: 1,
    referencedCount: 0,
    omittedCount: 1,
    rejectedCount: 1,
    blockedCount: 0,
    outcome: "projected",
    code: null,
  };
}

function createStream(
  publishers: readonly RuntimeEventPublisher[],
): RuntimeEventStream {
  return new RuntimeEventStream({
    runId: "run-1",
    taskId: "task-1",
    lineage: { kind: "root", root: { id: "run-1" }, depth: 0 },
    now: () => NOW,
    createEventId: ({ runId, sequence }) => `${runId}:runtime-event:${sequence}`,
    publishers,
  });
}

const NOW = "2026-08-13T00:00:00.000Z";

function runStartedIdentity(agentId: string) {
  return {
    activeAgentId: agentId,
    activeAgentRevision: "1",
    instructionBindingId: "run-1:agent-instruction-binding:0",
    instructionBindingRevision: `sha256:${"0".repeat(64)}`,
  };
}
